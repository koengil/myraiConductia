# Deploy VMs sit in the CI fleet's VPC and public subnet (infra/ci-runner), found
# by tag, behind their own security group: no ingress, all egress. The fleet's
# group admits no ingress either, so neither side can open a connection to the
# other (design R6). Egress stays open (GitHub, the Supabase pooler, Vercel, npm,
# apt); an allowlist is follow-up F3.

data "aws_vpc" "ci" {
  tags = {
    Name      = local.ci_runner_name
    Component = "ci-runner"
  }
}

data "aws_subnet" "public" {
  vpc_id = data.aws_vpc.ci.id

  tags = {
    Name      = "${local.ci_runner_name}-public"
    Component = "ci-runner"
  }
}

resource "aws_security_group" "deploy" {
  name        = local.name
  description = "Deploy runners: no ingress, all egress"
  vpc_id      = data.aws_vpc.ci.id

  tags = { Name = local.name }
}

resource "aws_vpc_security_group_egress_rule" "deploy_all" {
  security_group_id = aws_security_group.deploy.id
  description       = "All outbound (GitHub, Supabase pooler, Vercel, npm, apt)"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
