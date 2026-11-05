# Setup readiness operations

The authenticated `/setup` surface reports whether Microsoft 365 and Box are
ready without exposing secret values. Use this runbook when the surface shows
`Setup required` or `Configured, not active`.

## Feature rollout

Apply `20260814230000_setup_walkthroughs.sql`, then run `npm run seed:flags` to
materialize `setup_walkthroughs` as disabled in the target environment. Enable
the flag only after the migration and readiness checks pass. While the flag is
off, both setup API routes return `404` and the desktop and mobile navigation
entries remain hidden.

## Microsoft 365

All four server settings are required:

- `MS_CLIENT_ID`
- `MS_CLIENT_SECRET`
- `MS_REDIRECT_URI`
- `MAILBOX_TOKEN_KEY`, a 32-byte key encoded as 64 hexadecimal characters

The `mail_channel` feature flag must also be enabled. The Azure application
uses delegated `offline_access User.Read Mail.Send` permissions. The redirect
URI must end at `/api/v1/mailbox/callback` for the deployed origin.

After configuration, perform an end-to-end smoke with a non-production test
identity:

1. Open `/setup` and select **Connect Microsoft 365**.
2. Complete Microsoft consent and confirm `/setup` reports the expected email.
3. Open a deal Mail surface and send a non-sensitive test message through the
   screened channel.
4. Confirm the message has the connected sender identity and the send audit
   event exists.
5. Disconnect from Mail settings if the test identity must not remain linked.

Do not paste OAuth codes, tokens, or `MAILBOX_TOKEN_KEY` into tickets or logs.

## Box data room

Credential readiness requires:

- `BOX_CLIENT_ID`
- `BOX_SECRET` (`BOX_CLIENT_SECRET` remains a legacy alias)
- `BOX_ENTERPRISE_ID`

`STORAGE_PROVIDER=box` makes Box the active data-room provider. If credentials
exist while another provider is selected, `/setup` reports `Configured, not
active`.

Run `npm run smoke:box` with the deployment environment file before enabling
Box in a new environment. Then upload and download a non-sensitive test file
through both the internal Deal Folder and external Data Room paths. Confirm
room, classification, and phase checks still produce the expected visible and
opaque not-found results.

## Walkthrough evidence

Walkthrough completion writes a versioned `attest` audit event. It demonstrates
that the user completed Conductia product guidance. It does not certify formal
employer or regulatory training. Compliance-owned training and attestations
must remain in the employer's approved system unless a separately approved
requirements document changes that boundary.

Content version `1` is deliberately pinned in both application constants and
the database CHECK. Publishing version `2` requires one coordinated migration
that widens the CHECK and adds the new fixed step IDs, plus matching application
constants and schema-synchronization tests. Existing version `1` attestations
must remain readable and immutable.
