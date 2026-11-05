output "instance_ids" {
  description = "Runner instance ids by class."
  value = {
    for class in keys(var.runner_classes) :
    class => [for k, r in local.runners : aws_instance.runner[k].id if r.class == class]
  }
}

output "vpc_id" {
  value = aws_vpc.runner.id
}

output "log_group" {
  value = aws_cloudwatch_log_group.runner.name
}

output "wake_function_name" {
  value = aws_lambda_function.wake.function_name
}

# user_data is ignored after creation, so a host keeps the scripts it booted
# with. scripts/push-idle-stop.sh installs this rendered idle-stop.sh on a
# class's running hosts over SSM (base64, one entry per class).
output "idle_stop_script_b64" {
  description = "Rendered idle-stop.sh per runner class, base64."
  value = {
    for class, c in var.runner_classes :
    class => base64encode(templatefile("${path.module}/templates/idle-stop.sh.tftpl", { idle_minutes = c.idle_minutes }))
  }
}
