# One on-demand instance per runner (class, index), each registering one GitHub
# Actions runner at first boot (templates/). Instances are long-lived and
# stop/start; they are not replaced when the AMI or cloud-init changes
# (ignore_changes below). To roll: `tofu apply -replace='aws_instance.runner["light-1"]'`
# one runner at a time (README).
#
# IMDSv2 is required with a hop limit of 1: the host (the runner, the CloudWatch
# agent, the SSM agent) reaches the metadata service, while a Docker container
# on a bridge network is one hop further and cannot read the instance role.
#
# The idle threshold is the instance tag IdleMinutes, read by idle-stop.sh at
# every run through instance-metadata tags, so changing a class's idle_minutes
# only retags (in place). The number baked into user_data is the fallback when
# the tag cannot be read.

data "aws_ssm_parameter" "ubuntu" {
  count = var.ami_id == null ? 1 : 0
  name  = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

locals {
  ami_id = var.ami_id != null ? var.ami_id : nonsensitive(data.aws_ssm_parameter.ubuntu[0].value)

  scripts = {
    setup      = file("${path.module}/templates/setup.sh")
    register   = file("${path.module}/templates/register.sh")
    reregister = file("${path.module}/templates/reregister.sh")
    clean      = file("${path.module}/templates/clean.sh")
    cwagent    = templatefile("${path.module}/templates/cloudwatch-agent.json.tftpl", { log_group = local.log_group })
  }
}

resource "aws_instance" "runner" {
  for_each = local.runners

  ami                                  = local.ami_id
  instance_type                        = each.value.instance_type
  subnet_id                            = aws_subnet.public.id
  vpc_security_group_ids               = [aws_security_group.runner.id]
  iam_instance_profile                 = aws_iam_instance_profile.runner.name
  instance_initiated_shutdown_behavior = "stop"
  monitoring                           = false

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = each.value.volume_gb
    encrypted             = true
    delete_on_termination = true
    tags                  = merge(local.tags, { Name = "${local.name}-${each.key}", RunnerClass = each.value.class })
  }

  user_data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    region          = var.region
    repo            = var.github_repo
    runner_class    = each.value.class
    runner_labels   = join(",", each.value.labels)
    token_parameter = local.token_parameter
    scripts = merge(local.scripts, {
      idle_stop = templatefile("${path.module}/templates/idle-stop.sh.tftpl", { idle_minutes = each.value.idle_minutes })
    })
  })

  tags = {
    Name        = "${local.name}-${each.key}"
    RunnerClass = each.value.class
    IdleMinutes = tostring(each.value.idle_minutes)
  }

  lifecycle {
    ignore_changes = [ami, user_data]
  }

  depends_on = [aws_route_table_association.public, aws_cloudwatch_log_group.runner]
}
