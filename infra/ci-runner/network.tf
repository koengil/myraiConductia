# One public subnet, no NAT. The runners need outbound internet only; their
# security group admits no inbound traffic and no key pair exists (shell access
# is SSM Session Manager through the instance role).

resource "aws_vpc" "runner" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = local.name }
}

# The default group admits nothing, so nothing gets the AWS default rules.
resource "aws_default_security_group" "runner" {
  vpc_id = aws_vpc.runner.id
}

resource "aws_internet_gateway" "runner" {
  vpc_id = aws_vpc.runner.id

  tags = { Name = local.name }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.runner.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 0)
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = true

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.runner.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.runner.id
  }

  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "runner" {
  name        = local.name
  description = "CI runners: no ingress, all egress"
  vpc_id      = aws_vpc.runner.id

  tags = { Name = local.name }
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.runner.id
  description       = "All outbound (GitHub, registries, npm, Supabase images)"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
