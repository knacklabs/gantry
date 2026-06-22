# Control module: internet-facing ALB with role-aware path routing. The PUBLIC
# listener forwards only explicit path patterns, each to the target group for
# the role that serves it:
#   - api_path_patterns   (/v1/*)       -> the CONTROL target group. The full
#                                          admin/settings API plus SDK session
#                                          messages and external ingress; only
#                                          the control role (or an `all` worker)
#                                          serves these. Worker roles 404 admin
#                                          routes, so /v1/* must not land on them.
#   - webhook_path_patterns (/webhooks/*) -> the LIVE target group. Provider
#                                          inbound webhooks belong to the role
#                                          with providerInbound (live-worker, or
#                                          an `all` worker). Today most provider
#                                          inbound is worker-initiated polling/
#                                          socket (no ALB hop); this pattern is
#                                          the correct home for HTTP webhook
#                                          ingress as it is wired.
# Operational endpoints (/metrics and any admin paths) are NOT exposed on the
# public listener — /metrics is internal-only; /healthz and /readyz are consumed
# by each target group's health check, not published as public routes. Anything
# that does not match a public path pattern gets a fixed 404, so the runtime's
# operational surface is never reachable from the internet.
#
# Single-pool stacks (the `all`-role support env) register their one worker to
# BOTH target groups, so the same instance receives /v1/* and /webhooks/*.

resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = "Gantry public ALB ingress"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name_prefix}-alb-sg" })
}

resource "aws_security_group_rule" "alb_ingress_https" {
  count             = var.certificate_arn != "" ? 1 : 0
  type              = "ingress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  security_group_id = aws_security_group.alb.id
  cidr_blocks       = var.ingress_cidrs
  description       = "HTTPS from allowed CIDRs"
}

resource "aws_security_group_rule" "alb_ingress_http" {
  # HTTP listener only redirects to HTTPS; public forwarding requires TLS.
  type              = "ingress"
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  security_group_id = aws_security_group.alb.id
  cidr_blocks       = var.ingress_cidrs
  description       = "HTTP from allowed CIDRs"
}

resource "aws_security_group_rule" "alb_egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  security_group_id = aws_security_group.alb.id
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "Allow ALB to reach worker targets"
}

resource "aws_lb" "this" {
  name               = "${var.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids
  idle_timeout       = var.idle_timeout_seconds

  tags = merge(var.tags, { Name = "${var.name_prefix}-alb" })
}

# Control target group: receives the admin/settings API + SDK sessions +
# external ingress (/v1/*). The control role (or an `all` worker) registers here.
resource "aws_lb_target_group" "control" {
  name        = "${var.name_prefix}-control"
  port        = var.control_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = var.target_type

  deregistration_delay = var.deregistration_delay_seconds

  health_check {
    enabled             = true
    path                = var.health_check_path
    port                = "traffic-port"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-control-tg" })
}

# Live target group: receives provider inbound webhooks (/webhooks/*). The
# live-worker role (or an `all` worker) registers here. Health-checks /readyz the
# same way; ops-only API still serves /readyz for the ASG/ALB health check.
resource "aws_lb_target_group" "live" {
  name        = "${var.name_prefix}-live"
  port        = var.control_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = var.target_type

  deregistration_delay = var.deregistration_delay_seconds

  health_check {
    enabled             = true
    path                = var.health_check_path
    port                = "traffic-port"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }

  tags = merge(var.tags, { Name = "${var.name_prefix}-live-tg" })
}

# --- HTTPS listener (when a cert is supplied). Default action 404s anything
#     not matched by the public path rules below. ---
resource "aws_lb_listener" "https" {
  count             = var.certificate_arn != "" ? 1 : 0
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not Found"
      status_code  = "404"
    }
  }
}

# /v1/* (admin/settings API, SDK sessions, external ingress) -> control TG.
resource "aws_lb_listener_rule" "https_api_paths" {
  count        = var.certificate_arn != "" ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.control.arn
  }

  condition {
    path_pattern {
      values = var.api_path_patterns
    }
  }
}

# /webhooks/* (provider inbound webhooks) -> live TG (providerInbound role).
resource "aws_lb_listener_rule" "https_webhook_paths" {
  count        = var.certificate_arn != "" && var.enable_webhook_paths ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 110

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.live.arn
  }

  condition {
    path_pattern {
      values = var.webhook_path_patterns
    }
  }
}

# --- HTTP listener redirects to HTTPS. Public path forwarding is HTTPS-only. ---
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
