# No-ingress network (design R11): two private subnets for the tasks, one public
# subnet holding a single NAT gateway, and a security group with no ingress and
# egress on tcp 443 and 5432 only.
#
# 5432 stays open to 0.0.0.0/0 on purpose: the Supabase session pooler has no
# fixed address range, and a hand-kept prefix list would break silently when it
# moves. The DNS Firewall allowlist (detection.tf) limits what 5432 can resolve to.
# A compromised task can still reach any IP literal on 443 or 5432: a recorded
# residual G0 signs.

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "worker" {
  cidr_block           = "10.44.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

# The VPC's default security group admits nothing, so nothing launched without an
# explicit group gets the AWS default rules.
resource "aws_default_security_group" "worker" {
  vpc_id = aws_vpc.worker.id
}

resource "aws_subnet" "private" {
  count                   = 2
  vpc_id                  = aws_vpc.worker.id
  cidr_block              = cidrsubnet(aws_vpc.worker.cidr_block, 4, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false

  tags = { Name = "${local.name}-private-${count.index}" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.worker.id
  cidr_block              = cidrsubnet(aws_vpc.worker.cidr_block, 8, 128)
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false

  tags = { Name = "${local.name}-public" }
}

resource "aws_internet_gateway" "worker" {
  vpc_id = aws_vpc.worker.id

  tags = { Name = local.name }
}

resource "aws_eip" "nat" {
  domain = "vpc"

  tags = { Name = "${local.name}-nat" }
}

resource "aws_nat_gateway" "worker" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public.id

  tags       = { Name = local.name }
  depends_on = [aws_internet_gateway.worker]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.worker.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.worker.id
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.worker.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.worker.id
  }

  tags = { Name = "${local.name}-private" }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# The tasks' only security group. No ingress rule exists in this module; the
# provider removes AWS's default allow-all egress, so the two rules below are the
# whole of it.
resource "aws_security_group" "worker" {
  name        = local.name
  description = "Discovery worker tasks: no ingress, egress tcp 443 and 5432"
  vpc_id      = aws_vpc.worker.id

  tags = { Name = local.name }
}

resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.worker.id
  description       = "Supabase REST, Google APIs, ECR, CloudWatch Logs, Secrets Manager, SSM"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "pooler" {
  security_group_id = aws_security_group.worker.id
  description       = "Supabase session pooler (discovery_queue)"
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
  cidr_ipv4         = "0.0.0.0/0"
}
