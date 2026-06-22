data "aws_ssm_parameter" "ecs_ami" {
  count = trimspace(var.ami_id) == "" ? 1 : 0

  name = var.ami_ssm_parameter
}

locals {
  asg_name = "${var.name_prefix}-ecs-capacity"
  image_id = trimspace(var.ami_id) != "" ? var.ami_id : data.aws_ssm_parameter.ecs_ami[0].value
}

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

resource "aws_iam_role" "instance" {
  name               = "${local.asg_name}-instance"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "ecs" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "instance" {
  name = "${local.asg_name}-instance"
  role = aws_iam_role.instance.name
}

resource "aws_security_group" "instance" {
  name        = local.asg_name
  description = "Gantry ECS container instances"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${local.asg_name}-sg" })
}

resource "aws_security_group_rule" "egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  security_group_id = aws_security_group.instance.id
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "Egress for ECS agent, image pulls, and ECS task traffic"
}

resource "aws_launch_template" "instance" {
  name_prefix   = "${local.asg_name}-"
  image_id      = local.image_id
  instance_type = var.instance_type
  user_data = base64encode(<<-USERDATA
#!/bin/bash
set -euo pipefail
cat >/etc/ecs/ecs.config <<EOF
ECS_CLUSTER=${var.cluster_name}
ECS_ENABLE_CONTAINER_METADATA=true
ECS_AWSVPC_BLOCK_IMDS=true
EOF
  USERDATA
  )

  iam_instance_profile {
    arn = aws_iam_instance_profile.instance.arn
  }

  vpc_security_group_ids = [aws_security_group.instance.id]

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_size           = var.root_volume_gb
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = local.asg_name })
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = var.tags
}

resource "aws_autoscaling_group" "instance" {
  name                  = local.asg_name
  min_size              = var.min_size
  max_size              = var.max_size
  desired_capacity      = var.desired_capacity
  vpc_zone_identifier   = var.subnet_ids
  protect_from_scale_in = true

  launch_template {
    id      = aws_launch_template.instance.id
    version = "$Latest"
  }

  tag {
    key                 = "Name"
    value               = local.asg_name
    propagate_at_launch = true
  }

  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
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
    ignore_changes        = [desired_capacity]
  }
}
