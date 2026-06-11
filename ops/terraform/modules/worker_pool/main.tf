# Worker pool module: launch template + ASG running the runtime container.
# A terminate lifecycle hook drives graceful drain (SIGTERM -> container stop
# with grace period -> complete lifecycle action). Instance refresh rolls the
# fleet onto a new image with bounded healthy capacity.

data "aws_region" "current" {}

locals {
  asg_name            = "${var.name_prefix}-${var.worker_role}"
  lifecycle_hook_name = "${local.asg_name}-drain"
}

# --- Instance role: assume by EC2, plus SSM core, lifecycle-action completion,
#     and the caller-provided policy ARNs (artifact RO, secret read). ---
data "aws_iam_policy_document" "assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "worker" {
  name               = "${local.asg_name}-instance"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "extra" {
  count      = length(var.instance_policy_arns)
  role       = aws_iam_role.worker.name
  policy_arn = var.instance_policy_arns[count.index]
}

# Allow the instance to complete its own ASG lifecycle action during drain.
data "aws_iam_policy_document" "lifecycle" {
  statement {
    sid       = "CompleteLifecycleAction"
    effect    = "Allow"
    actions   = ["autoscaling:CompleteLifecycleAction", "autoscaling:RecordLifecycleActionHeartbeat"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "lifecycle" {
  name   = "${local.asg_name}-lifecycle"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.lifecycle.json
}

resource "aws_iam_instance_profile" "worker" {
  name = "${local.asg_name}-instance"
  role = aws_iam_role.worker.name
}

# --- Worker security group: control port reachable from the ALB SG only. ---
resource "aws_security_group" "worker" {
  name        = local.asg_name
  description = "Gantry worker pool (${var.worker_role})"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = local.asg_name })
}

resource "aws_security_group_rule" "worker_ingress_alb" {
  count                    = var.alb_security_group_id != "" ? 1 : 0
  type                     = "ingress"
  from_port                = var.control_port
  to_port                  = var.control_port
  protocol                 = "tcp"
  security_group_id        = aws_security_group.worker.id
  source_security_group_id = var.alb_security_group_id
  description              = "Control port from ALB"
}

resource "aws_security_group_rule" "worker_egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  security_group_id = aws_security_group.worker.id
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "Egress for image pulls, RDS Proxy, S3 endpoint, provider APIs"
}

locals {
  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    image_ref               = var.image_ref
    control_port            = var.control_port
    drain_deadline_seconds  = var.drain_deadline_seconds
    lifecycle_hook_name     = local.lifecycle_hook_name
    asg_name                = local.asg_name
    aws_region              = data.aws_region.current.name
    worker_role             = var.worker_role
    runtime_secret_env_refs = var.runtime_secret_env_refs
  })
}

resource "aws_launch_template" "worker" {
  name_prefix   = "${local.asg_name}-"
  image_id      = var.ami_id
  instance_type = var.instance_type
  user_data     = base64encode(local.user_data)

  iam_instance_profile {
    arn = aws_iam_instance_profile.worker.arn
  }

  vpc_security_group_ids = [aws_security_group.worker.id]

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = local.asg_name, GantryWorkerRole = var.worker_role })
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = var.tags
}

resource "aws_autoscaling_group" "worker" {
  name                = local.asg_name
  min_size            = var.min_size
  max_size            = var.max_size
  desired_capacity    = var.desired_capacity
  vpc_zone_identifier = var.subnet_ids
  target_group_arns   = var.target_group_arns

  health_check_type         = length(var.target_group_arns) > 0 ? "ELB" : "EC2"
  health_check_grace_period = 90

  launch_template {
    id      = aws_launch_template.worker.id
    version = "$Latest"
  }

  # Roll the fleet onto a new image/template with bounded healthy capacity.
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = var.min_healthy_percentage
      instance_warmup        = 90
    }
    triggers = ["launch_template"]
  }

  # Terminate lifecycle hook: holds the instance in Terminating:Wait so the
  # on-instance watcher can drain the container before the ASG proceeds.
  initial_lifecycle_hook {
    name                 = local.lifecycle_hook_name
    lifecycle_transition = "autoscaling:EC2_INSTANCE_TERMINATING"
    default_result       = "CONTINUE"
    heartbeat_timeout    = var.drain_deadline_seconds + 30
  }

  tag {
    key                 = "Name"
    value               = local.asg_name
    propagate_at_launch = true
  }

  dynamic "tag" {
    for_each = var.tags
    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = true
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}
