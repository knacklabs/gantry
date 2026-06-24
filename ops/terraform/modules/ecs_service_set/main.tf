locals {
  deployment_roles = {
    api-only  = ["control"]
    chat-only = ["control", "live-worker"]
    jobs-only = ["job-worker"]
    all       = ["control", "live-worker", "job-worker"]
  }

  enabled_roles = toset(local.deployment_roles[var.deployment_type])

  default_service_configs = var.service_configs

  services = {
    for role in local.enabled_roles : role => {
      name     = "${var.name_prefix}-${role}"
      role     = role
      config   = local.default_service_configs[role]
      strategy = lookup(var.service_capacity_provider_strategy, role, var.default_capacity_provider_strategy)
    }
  }

  runtime_secret_arns = distinct(concat(
    [for ref in var.runtime_secret_env_refs : ref.secret_arn],
    flatten([
      for refs in values(var.runtime_secret_env_refs_by_role) : [
        for ref in refs : ref.secret_arn
      ]
    ]),
  ))

  created_capacity_provider_names = [
    for provider in aws_ecs_capacity_provider.ec2 : provider.name
  ]

  cluster_capacity_provider_names = distinct(concat(
    local.created_capacity_provider_names,
    var.external_capacity_provider_names,
  ))

  common_environment = merge(
    {
      NODE_ENV                   = "production"
      GANTRY_SECURITY_POSTURE    = "production"
      GANTRY_CONTROL_HOST        = "0.0.0.0"
      GANTRY_HOME                = "/var/lib/gantry"
      GANTRY_FLEET_SETTINGS_AUTO = "1"
      GANTRY_ARTIFACT_BUCKET     = var.artifact_bucket_name
      AWS_REGION                 = data.aws_region.current.name
    },
    var.environment,
  )

  task_policy_attachments = {
    for attachment in flatten([
      for role in keys(local.services) : [
        for index, policy_arn in distinct(concat(
          var.task_policy_arns,
          lookup(var.task_policy_arns_by_role, role, []),
          )) : {
          key        = "${role}-${index}"
          role       = role
          policy_arn = policy_arn
        }
      ]
    ]) : attachment.key => attachment
  }
}

resource "aws_ecs_cluster" "this" {
  name = "${var.name_prefix}-ecs"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-ecs" })
}

resource "aws_ecs_capacity_provider" "ec2" {
  for_each = var.ec2_capacity_providers

  name = "${var.name_prefix}-${each.key}"

  auto_scaling_group_provider {
    auto_scaling_group_arn         = each.value.auto_scaling_group_arn
    managed_termination_protection = each.value.managed_termination_protection

    managed_scaling {
      status          = each.value.managed_scaling_status
      target_capacity = each.value.managed_scaling_target_capacity
    }
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-${each.key}" })
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  count = length(local.cluster_capacity_provider_names) > 0 ? 1 : 0

  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = local.cluster_capacity_provider_names

  dynamic "default_capacity_provider_strategy" {
    for_each = var.default_capacity_provider_strategy
    content {
      capacity_provider = default_capacity_provider_strategy.value.capacity_provider
      weight            = default_capacity_provider_strategy.value.weight
      base              = default_capacity_provider_strategy.value.base
    }
  }
}

data "aws_iam_policy_document" "task_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.name_prefix}-ecs-task-execution"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "runtime_secret_read" {
  count = length(local.runtime_secret_arns) > 0 ? 1 : 0

  statement {
    sid       = "ReadRuntimeSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = local.runtime_secret_arns
  }

  dynamic "statement" {
    for_each = length(var.secret_kms_key_arns) > 0 ? [1] : []
    content {
      sid       = "DecryptRuntimeSecrets"
      effect    = "Allow"
      actions   = ["kms:Decrypt"]
      resources = var.secret_kms_key_arns
    }
  }
}

resource "aws_iam_role_policy" "runtime_secret_read" {
  count = length(local.runtime_secret_arns) > 0 ? 1 : 0

  name   = "${var.name_prefix}-ecs-runtime-secret-read"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.runtime_secret_read[0].json
}

resource "aws_iam_role" "task" {
  for_each = local.services

  name               = "${each.value.name}-task"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "task_extra" {
  for_each = local.task_policy_attachments

  role       = aws_iam_role.task[each.value.role].name
  policy_arn = each.value.policy_arn
}

resource "aws_cloudwatch_log_group" "service" {
  for_each = local.services

  name              = "/gantry/${var.name_prefix}/${each.key}"
  retention_in_days = 30
  tags              = var.tags
}

resource "aws_security_group" "service" {
  name        = "${var.name_prefix}-ecs"
  description = "Gantry ECS services"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name_prefix}-ecs-sg" })
}

resource "aws_security_group_rule" "control_ingress_alb" {
  count = contains(local.enabled_roles, "control") && var.control_target_group_arn != "" && var.alb_security_group_id != "" ? 1 : 0

  type                     = "ingress"
  from_port                = var.control_port
  to_port                  = var.control_port
  protocol                 = "tcp"
  security_group_id        = aws_security_group.service.id
  source_security_group_id = var.alb_security_group_id
  description              = "Control service port from ALB"
}

resource "aws_security_group_rule" "egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  security_group_id = aws_security_group.service.id
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "Egress for RDS Proxy, artifacts, image pulls, Secrets Manager, and provider APIs"
}

resource "aws_ecs_task_definition" "service" {
  for_each = local.services

  family                   = each.value.name
  network_mode             = "awsvpc"
  requires_compatibilities = ["EC2"]
  cpu                      = each.value.config.task_cpu
  memory                   = each.value.config.task_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task[each.key].arn

  container_definitions = jsonencode([
    {
      name      = "gantry"
      image     = var.image_ref
      essential = true

      portMappings = [
        {
          containerPort = var.control_port
          hostPort      = var.control_port
          protocol      = "tcp"
        }
      ]

      environment = concat(
        [
          { name = "GANTRY_PROCESS_ROLE", value = each.value.role },
          { name = "GANTRY_CONTROL_PORT", value = tostring(var.control_port) },
          {
            name  = "GANTRY_SKIP_MIGRATIONS"
            value = each.value.role == "control" || !contains(local.enabled_roles, "control") ? "0" : "1"
          },
        ],
        [
          for name, value in local.common_environment : {
            name  = name
            value = value
          }
        ],
      )

      secrets = [
        for ref in concat(
          var.runtime_secret_env_refs,
          lookup(var.runtime_secret_env_refs_by_role, each.value.role, []),
          ) : {
          name      = ref.env_name
          valueFrom = ref.secret_arn
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "gantry"
        }
      }

      privileged = var.privileged_containers

      linuxParameters = {
        initProcessEnabled = true
      }

      healthCheck = {
        command = [
          "CMD-SHELL",
          "node -e \"fetch('http://127.0.0.1:${var.control_port}/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
        ]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
    }
  ])

  tags = merge(var.tags, { Name = each.value.name })
}

resource "aws_ecs_service" "service" {
  for_each = local.services

  name                   = each.value.name
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.service[each.key].arn
  desired_count          = each.value.config.desired_count
  enable_execute_command = var.enable_execute_command
  force_new_deployment   = var.force_new_deployment
  launch_type            = length(each.value.strategy) == 0 ? "EC2" : null

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds = (
    (each.key == "control" && var.control_target_group_arn != "") ||
    (each.key == "live-worker" && var.live_target_group_arn != "")
  ) ? 90 : null

  network_configuration {
    subnets         = var.subnet_ids
    security_groups = [aws_security_group.service.id]
  }

  dynamic "capacity_provider_strategy" {
    for_each = each.value.strategy
    content {
      capacity_provider = capacity_provider_strategy.value.capacity_provider
      weight            = capacity_provider_strategy.value.weight
      base              = capacity_provider_strategy.value.base
    }
  }

  dynamic "load_balancer" {
    for_each = each.key == "control" && var.control_target_group_arn != "" ? [
      var.control_target_group_arn,
      ] : each.key == "live-worker" && var.live_target_group_arn != "" ? [
      var.live_target_group_arn,
    ] : []
    content {
      target_group_arn = load_balancer.value
      container_name   = "gantry"
      container_port   = var.control_port
    }
  }

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_ecs_cluster_capacity_providers.this]

  tags = merge(var.tags, { Name = each.value.name })
}

resource "aws_appautoscaling_target" "service" {
  for_each = {
    for role, service in local.services : role => service
    if service.config.autoscaling_enabled
  }

  max_capacity       = each.value.config.max_capacity
  min_capacity       = each.value.config.min_capacity
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.service[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu_target" {
  for_each = aws_appautoscaling_target.service

  name               = "${local.services[each.key].name}-cpu-target"
  policy_type        = "TargetTrackingScaling"
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension
  service_namespace  = each.value.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value = local.services[each.key].config.cpu_target_value

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

data "aws_region" "current" {}
