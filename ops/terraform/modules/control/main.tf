# Control module: internet-facing ALB. The PUBLIC listener forwards only the
# explicit webhook/API path patterns to the worker target group. Operational
# endpoints (/metrics and any admin paths) are NOT exposed on the public
# listener — /metrics is internal-only; /healthz and /readyz are consumed by the
# target-group health check, not published as public routes. Anything that does
# not match a public path pattern gets a fixed 404, so the runtime's operational
# surface is never reachable from the internet.

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
  # HTTP listener exists either as the only listener (no cert) or to redirect.
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

resource "aws_lb_target_group" "workers" {
  name        = "${var.name_prefix}-workers"
  port        = var.control_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "instance"

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

  tags = merge(var.tags, { Name = "${var.name_prefix}-workers-tg" })
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

resource "aws_lb_listener_rule" "https_public_paths" {
  count        = var.certificate_arn != "" ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.workers.arn
  }

  condition {
    path_pattern {
      values = var.public_path_patterns
    }
  }
}

# --- HTTP listener. With a cert, redirect to HTTPS. Without, it is the only
#     listener and forwards public paths directly (rehearsal posture). ---
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = var.certificate_arn != "" ? "redirect" : "fixed-response"

    dynamic "redirect" {
      for_each = var.certificate_arn != "" ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }

    dynamic "fixed_response" {
      for_each = var.certificate_arn == "" ? [1] : []
      content {
        content_type = "text/plain"
        message_body = "Not Found"
        status_code  = "404"
      }
    }
  }
}

resource "aws_lb_listener_rule" "http_public_paths" {
  count        = var.certificate_arn == "" ? 1 : 0
  listener_arn = aws_lb_listener.http.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.workers.arn
  }

  condition {
    path_pattern {
      values = var.public_path_patterns
    }
  }
}
