<#
.SYNOPSIS
  Registers Conductia's read-only deal-discovery Graph reader in ONE bank tenant
  (ADR-005). Step 2 of scripts/m365/README.md. Run by the bank's administrator.

.DESCRIPTION
  Creates a single-tenant, app-only application with a certificate credential and
  grants it exactly these things:

    1. Mail.Read through RBAC for Applications in Exchange Online, limited by a
       management scope to the members of one mail-enabled security group. The
       Entra "Mail.Read" application permission is deliberately NOT granted: it
       would reach every mailbox in the tenant.
    2. Sites.Selected in Microsoft Graph, then "read" on each listed SharePoint
       site. Every other site stays unreadable.
    3. A Graph group-membership read (-GroupReadRole), so Conductia can compare
       the scope group's members with the mailboxes it is allowed to read on
       every pass (#275), plus User.ReadBasic.All: without it the group read
       returns members with no UPN, and the guard refuses every mailbox (seen
       on the 2026-10-19 rehearsal). Both read directory basics, never mail.

  The Graph application permissions, the Exchange management scope and its role
  assignment are each made only when missing, so a re-run against an existing
  application grants only the permissions it lacks.

  The scope group's members include every mailbox Exchange lists as a
  UserMailbox recipient: user, shared (team inbox), room and equipment
  mailboxes alike.

  It never creates or handles a private key. Pass the PUBLIC certificate (.cer)
  exported from Azure Key Vault (README step 1); the script refuses a file that
  carries a private key. It writes a starting config for write-registration.ts,
  whose owner fields an administrator must complete by hand. The config names
  the scope group by its Entra object id (scopeGroupId).

  Supports -WhatIf: prints each change without making it.

.PARAMETER TenantId
  The bank's Entra tenant id (GUID).
.PARAMETER CertificatePath
  Path to the public certificate (.cer, DER or Base64) of the Key Vault certificate.
.PARAMETER ScopeGroupEmail
  Primary SMTP address of the mail-enabled security group whose members are the
  in-scope mailboxes.
.PARAMETER SiteIds
  Graph site ids (host,siteGuid,webGuid) to grant read on. May be empty.
.PARAMETER OutputPath
  Where to write the starting write-registration config (keep it outside the repo).
.PARAMETER AppName
  Display name of the application. Defaults to "Conductia Deal Discovery Reader".
.PARAMETER GroupReadRole
  The Graph application permission that reads the scope group's members:
  GroupMember.ReadBasic.All (the least privileged, tried first) or
  GroupMember.Read.All (if ReadBasic cannot be granted in the tenant, or the
  member listing is refused under it). Neither can be limited to one group.
.PARAMETER DisableWam
  Sign in to Exchange Online in a browser window instead of the Windows sign-in
  broker (Connect-ExchangeOnline -DisableWAM). Use it when the broker closes the
  sign-in before MFA finishes, or refuses a passkey.

.EXAMPLE
  ./register-reader.ps1 -TenantId 11111111-2222-3333-4444-555555555555 `
    -CertificatePath ./conductia-reader.cer -ScopeGroupEmail conductia-discovery@bank.example `
    -SiteIds 'bank.sharepoint.com,aaaa...,bbbb...' -OutputPath ~/conductia-registration.json -WhatIf

.NOTES
  Requires PowerShell 7+, Microsoft.Graph (Applications, Sites) and
  ExchangeOnlineManagement 3.x. The signed-in administrator needs Application
  Administrator (or Cloud Application Administrator), Privileged Role
  Administrator for the admin consent, Exchange Administrator, and
  Sites.FullControl.All consent to grant per-site permissions.
  RBAC for Applications assignments can take up to two hours to take effect;
  run probe-out-of-scope.ts only after Test-ServicePrincipalAuthorization says
  InScope for a member mailbox.

  Signing in: if the interactive Graph sign-in fails (the Windows broker closes
  before MFA, or device code is blocked by policy), connect first with a token
  for this tenant that carries the scopes above, then run the script. It reuses
  a Graph or Exchange session for this tenant, refuses one for another tenant,
  and disconnects only the sessions it opened:

    Connect-MgGraph -AccessToken (ConvertTo-SecureString $token -AsPlainText -Force)

  A tenant that has never been customized refuses management scopes. The script
  stops before any change and says so: run Enable-OrganizationCustomization, wait
  about an hour for it (and the admin's delegating rights) to apply, then re-run.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$TenantId,
  [Parameter(Mandatory = $true)][string]$CertificatePath,
  [Parameter(Mandatory = $true)][string]$ScopeGroupEmail,
  [string[]]$SiteIds = @(),
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [string]$AppName = 'Conductia Deal Discovery Reader',
  # Least privilege first (design R1); ReadBasic was enough on the 2026-10-19 rehearsal.
  [ValidateSet('GroupMember.ReadBasic.All', 'GroupMember.Read.All')][string]$GroupReadRole = 'GroupMember.ReadBasic.All',
  [switch]$DisableWam
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# ExchangeOnlineManagement's cmdlets are module functions, which do not inherit this script's ErrorActionPreference:
# a refused New-ManagementScope only printed an error and the script went on to write the config (2026-10-19).
# Every call that changes something below passes -ErrorAction Stop as well.

$GraphAppId = '00000003-0000-0000-c000-000000000000'
$ScopeName = "$AppName scope"

# ── The public certificate ────────────────────────────────────────────────────
$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new((Resolve-Path $CertificatePath).Path)
if ($cert.HasPrivateKey) {
  throw 'The certificate file carries a private key. Export only the public .cer; the key stays in Key Vault.'
}
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$thumbprintSha256 = ([System.BitConverter]::ToString($sha256.ComputeHash($cert.RawData))).Replace('-', '').ToLowerInvariant()
Write-Host "Certificate: $($cert.Subject), SHA-256 thumbprint $thumbprintSha256, expires $($cert.NotAfter.ToString('u'))"

# ── Entra: the application, its service principal, its Graph permissions ─────
Import-Module Microsoft.Graph.Applications
Import-Module Microsoft.Graph.Sites
$graphScopes = @('Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All', 'Sites.FullControl.All')
# Reuse a session connected beforehand (for example with -AccessToken, see .NOTES), but only for this tenant.
$openedGraph = $false
$mgContext = Get-MgContext
if ($mgContext) {
  if ($mgContext.TenantId -ne $TenantId) { throw "Graph is connected to tenant $($mgContext.TenantId), not $TenantId. Run Disconnect-MgGraph first." }
  $missing = @($graphScopes | Where-Object { $mgContext.Scopes -notcontains $_ })
  if ($missing.Count -gt 0) { throw "The Graph session lacks $($missing -join ', '). Connect again with those scopes." }
  Write-Host "Reusing the Graph session of $($mgContext.Account) in $TenantId"
} else {
  Connect-MgGraph -TenantId $TenantId -NoWelcome -Scopes $graphScopes
  $openedGraph = $true
}

$graphSp = Get-MgServicePrincipal -Filter "appId eq '$GraphAppId'"
$sitesSelected = $graphSp.AppRoles | Where-Object { $_.Value -eq 'Sites.Selected' -and $_.AllowedMemberTypes -contains 'Application' }
if (-not $sitesSelected) { throw 'Sites.Selected was not found on Microsoft Graph in this tenant.' }
$groupRead = $graphSp.AppRoles | Where-Object { $_.Value -eq $GroupReadRole -and $_.AllowedMemberTypes -contains 'Application' }
if (-not $groupRead) {
  throw "$GroupReadRole was not found on Microsoft Graph in this tenant as an application permission. Run again with the other -GroupReadRole."
}
# The Graph application permissions the reader holds; nothing here reads mail. User.ReadBasic.All is required: the
# group read alone returns members without a UPN, so the mirror reads no mailbox (2026-10-19 rehearsal).
$userReadBasic = $graphSp.AppRoles | Where-Object { $_.Value -eq 'User.ReadBasic.All' -and $_.AllowedMemberTypes -contains 'Application' }
if (-not $userReadBasic) { throw 'User.ReadBasic.All was not found on Microsoft Graph in this tenant.' }
$graphRoles = @($sitesSelected, $groupRead, $userReadBasic)
$graphRoleNames = ($graphRoles | ForEach-Object { $_.Value }) -join ', '

$app = Get-MgApplication -Filter "displayName eq '$AppName'" | Select-Object -First 1
if (-not $app) {
  if ($PSCmdlet.ShouldProcess($AppName, "Create single-tenant application with a certificate credential and $graphRoleNames")) {
    $app = New-MgApplication -DisplayName $AppName -SignInAudience 'AzureADMyOrg' -ErrorAction Stop `
      -KeyCredentials @(@{
          Type        = 'AsymmetricX509Cert'
          Usage       = 'Verify'
          Key         = $cert.RawData
          DisplayName = "Conductia reader $($cert.NotAfter.ToString('yyyy-MM-dd'))"
        }) `
      -RequiredResourceAccess @(@{
          ResourceAppId  = $GraphAppId
          ResourceAccess = @($graphRoles | ForEach-Object { @{ Id = $_.Id; Type = 'Role' } })
        })
  }
} else {
  # The admin consent below is what grants a permission; the existing app's declared list is left as it is.
  Write-Host "Application '$AppName' exists ($($app.AppId)); leaving its credentials as they are."
}

$sp = $null
if ($app) {
  $sp = Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'" | Select-Object -First 1
  if (-not $sp -and $PSCmdlet.ShouldProcess($app.AppId, 'Create service principal')) {
    $sp = New-MgServicePrincipal -AppId $app.AppId -ErrorAction Stop
  }
}

if ($sp) {
  # Each permission is consented only when the service principal does not already hold it.
  foreach ($role in $graphRoles) {
    $granted = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id |
      Where-Object { $_.AppRoleId -eq $role.Id -and $_.ResourceId -eq $graphSp.Id }
    if ($granted) {
      Write-Host "Microsoft Graph $($role.Value) (application) is already granted."
    } elseif ($PSCmdlet.ShouldProcess($AppName, "Admin consent: Microsoft Graph $($role.Value) (application)")) {
      New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -PrincipalId $sp.Id `
        -ResourceId $graphSp.Id -AppRoleId $role.Id -ErrorAction Stop | Out-Null
    }
  }
  # Guard: a tenant-wide Mail.Read application grant would defeat the scope.
  $mailRead = $graphSp.AppRoles | Where-Object { $_.Value -eq 'Mail.Read' -and $_.AllowedMemberTypes -contains 'Application' }
  $tenantWide = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id |
    Where-Object { $_.AppRoleId -eq $mailRead.Id -and $_.ResourceId -eq $graphSp.Id }
  if ($tenantWide) {
    throw 'The application holds the tenant-wide Entra Mail.Read permission. Remove it; mail access comes only from RBAC for Applications.'
  }
}

# ── Exchange Online: RBAC for Applications, scoped to the group ──────────────
Import-Module ExchangeOnlineManagement
$openedExchange = $false
$exchange = @(Get-ConnectionInformation -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Connected' })
if ($exchange.Count -gt 0) {
  if (@($exchange | Where-Object { $_.TenantID -eq $TenantId }).Count -eq 0) {
    throw "Exchange Online is connected to another tenant. Run Disconnect-ExchangeOnline first."
  }
  Write-Host "Reusing the Exchange Online session in $TenantId"
} else {
  # -DisableWAM exists only in recent ExchangeOnlineManagement 3.x: passed only when asked for.
  $exoSignIn = @{ ShowBanner = $false; ErrorAction = 'Stop' }
  if ($DisableWam) { $exoSignIn.DisableWAM = $true }
  Connect-ExchangeOnline @exoSignIn
  $openedExchange = $true
}

# A tenant that was never customized refuses New-ManagementScope. Say so before any Exchange change.
if ((Get-OrganizationConfig -ErrorAction Stop).IsDehydrated) {
  throw 'This tenant needs Enable-OrganizationCustomization before a management scope can be created. Run it, wait about an hour for it and the delegating rights to apply, then run this script again.'
}

$group = Get-DistributionGroup -Identity $ScopeGroupEmail -ErrorAction Stop
if ($group.RecipientTypeDetails -ne 'MailUniversalSecurityGroup') {
  throw "$ScopeGroupEmail is not a mail-enabled security group ($($group.RecipientTypeDetails))."
}
# The group's Entra object id: what Graph lists the members of, and what write-registration.ts records (scopeGroupId).
$scopeGroupId = if ($group.ExternalDirectoryObjectId) { $group.ExternalDirectoryObjectId.ToString().ToLowerInvariant() } else { $null }
Write-Host "Scope group: $ScopeGroupEmail, Entra object id $(if ($scopeGroupId) { $scopeGroupId } else { 'not found' })"

if ($app -and $sp) {
  if (-not (Get-ServicePrincipal -Identity $app.AppId -ErrorAction SilentlyContinue)) {
    if ($PSCmdlet.ShouldProcess($app.AppId, 'Register the service principal in Exchange Online')) {
      New-ServicePrincipal -AppId $app.AppId -ObjectId $sp.Id -DisplayName $AppName -ErrorAction Stop | Out-Null
    }
  }
  if (-not (Get-ManagementScope -Identity $ScopeName -ErrorAction SilentlyContinue)) {
    if ($PSCmdlet.ShouldProcess($ScopeName, "Create a management scope for members of $ScopeGroupEmail")) {
      New-ManagementScope -Name $ScopeName -RecipientRestrictionFilter "MemberOfGroup -eq '$($group.DistinguishedName)'" -ErrorAction Stop | Out-Null
    }
  }
  $assigned = Get-ManagementRoleAssignment -RoleAssignee $app.AppId -Role 'Application Mail.Read' -ErrorAction SilentlyContinue
  if (-not $assigned -and $PSCmdlet.ShouldProcess($AppName, "Assign 'Application Mail.Read' within $ScopeName")) {
    New-ManagementRoleAssignment -App $app.AppId -Role 'Application Mail.Read' -CustomResourceScope $ScopeName -ErrorAction Stop | Out-Null
  }
  # Never write a config for an application Exchange has not scoped: read the assignment back (not under -WhatIf).
  if (-not $WhatIfPreference) {
    $scoped = @(Get-ManagementRoleAssignment -RoleAssignee $app.AppId -Role 'Application Mail.Read' -ErrorAction SilentlyContinue |
      Where-Object { $_.CustomResourceScope -eq $ScopeName })
    if ($scoped.Count -eq 0) {
      throw "'Application Mail.Read' is not assigned to $AppName within $ScopeName. Nothing was written; fix the Exchange step and re-run."
    }
  }
}

# Every mailbox the scope admits: RecipientType UserMailbox covers user, shared (team inbox), room and equipment
# mailboxes (RecipientTypeDetails tells them apart). Nested groups and contacts are not in the scope, so not here.
$mailboxMembers = @(Get-DistributionGroupMember -Identity $ScopeGroupEmail -ResultSize Unlimited -ErrorAction Stop |
  Where-Object { $_.RecipientType -eq 'UserMailbox' })
$members = @($mailboxMembers | ForEach-Object { $_.PrimarySmtpAddress.ToString().ToLowerInvariant() } | Sort-Object -Unique)
Write-Host "In-scope mailboxes ($($members.Count)): $($members -join ', ')"
$byType = @($mailboxMembers | Group-Object RecipientTypeDetails | Sort-Object Name | ForEach-Object { "$($_.Name) $($_.Count)" })
if ($byType.Count -gt 0) { Write-Host "  by type: $($byType -join ', ')" }
if ($app -and $members.Count -gt 0) {
  Write-Host 'Scope check for the first member (InScope should read True once the assignment has propagated):'
  Test-ServicePrincipalAuthorization -Identity $app.AppId -Resource $members[0] | Format-Table RoleName, InScope -AutoSize
}

# ── SharePoint: read on each listed site only ────────────────────────────────
foreach ($siteId in $SiteIds) {
  if ($app -and $PSCmdlet.ShouldProcess($siteId, "Grant '$AppName' read (Sites.Selected)")) {
    New-MgSitePermission -SiteId $siteId -ErrorAction Stop -BodyParameter @{
      roles               = @('read')
      grantedToIdentities = @(@{ application = @{ id = $app.AppId; displayName = $AppName } })
    } | Out-Null
  }
}

# ── The starting config for write-registration.ts ────────────────────────────
$sources = @()
foreach ($address in $members) { $sources += [ordered]@{ kind = 'mailbox'; address = $address; ownerEmail = 'FILL IN: the Conductia user who owns this mailbox (required: the guard refuses a mailbox with no owner)' } }
foreach ($siteId in $SiteIds) { $sources += [ordered]@{ kind = 'sharepoint_site'; address = $siteId; ownerEmail = 'FILL IN: the Conductia user who owns this site, or null' } }

# The mail domains of the in-scope mailboxes: the allowlist reads a mailbox only on a listed domain.
$mailboxDomains = @($members | ForEach-Object { ($_ -split '@')[-1].ToLowerInvariant() } | Sort-Object -Unique)

$config = [ordered]@{
  tenantId       = 'FILL IN: the Conductia tenant uuid'
  msTenantId     = $TenantId
  clientId       = if ($app) { $app.AppId } else { 'WHATIF: created on a real run' }
  certThumbprint = $thumbprintSha256
  certSecretRef  = 'FILL IN: keyvault:https://<vault>.vault.azure.net/keys/<name>/<version>'
  status         = 'pending'
  consentedAt    = (Get-Date).ToUniversalTime().ToString('o')
  firmCompany    = 'FILL IN: the bank company in Conductia (its id or exact name)'
  mailboxDomains = $mailboxDomains
  scopeGroupId   = if ($scopeGroupId) { $scopeGroupId } else { "FILL IN: the Entra object id (ExternalDirectoryObjectId) of $ScopeGroupEmail" }
  sources        = $sources
}
if ($PSCmdlet.ShouldProcess($OutputPath, 'Write the starting registration config')) {
  $config | ConvertTo-Json -Depth 5 | Set-Content -Path $OutputPath -Encoding utf8
  Write-Host "Wrote $OutputPath. Fill in every FILL IN value, set status to active, then run write-registration.ts."
}

# Only the sessions this script opened: a session connected beforehand stays for a re-run.
if ($openedExchange) { Disconnect-ExchangeOnline -Confirm:$false }
if ($openedGraph) { Disconnect-MgGraph | Out-Null }
