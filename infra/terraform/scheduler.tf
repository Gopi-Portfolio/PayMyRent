# Durable scheduled jobs: EventBridge rules → API destination (HTTPS) with a connection that sends
# X-Job-Key (secret kept by EventBridge in Secrets Manager). Retries + SQS dead-letter queue.
resource "random_password" "job_key" {
  length  = 48
  special = false
}

resource "aws_ssm_parameter" "job_key" {
  name  = "/paymyrent/${var.env}/RG_JOB_TRIGGER_SECRET"
  type  = "SecureString"
  value = random_password.job_key.result
}

resource "aws_cloudwatch_event_connection" "api" {
  name               = "paymyrent-${var.env}-jobs"
  authorization_type = "API_KEY"
  auth_parameters {
    api_key {
      key   = "X-Job-Key"
      value = random_password.job_key.result
    }
  }
}

locals {
  jobs = {
    generate_invoices      = "cron(0 19 * * ? *)"   # 00:30 IST
    send_reminders         = "cron(0 4 * * ? *)"    # 09:30 IST
    dispatch_notifications = "rate(15 minutes)"
    subscription_lifecycle = "rate(1 hour)"
    reconcile_payments     = "rate(15 minutes)"
  }
}

resource "aws_cloudwatch_event_api_destination" "job" {
  for_each                         = local.jobs
  name                             = "paymyrent-${var.env}-${replace(each.key, "_", "-")}"
  invocation_endpoint              = "https://${var.api_hostname}/api/v1/jobs/${each.key}"
  http_method                      = "POST"
  invocation_rate_limit_per_second = 1
  connection_arn                   = aws_cloudwatch_event_connection.api.arn
}

resource "aws_cloudwatch_event_rule" "job" {
  for_each            = local.jobs
  name                = "paymyrent-${var.env}-${replace(each.key, "_", "-")}"
  schedule_expression = each.value
}

resource "aws_sqs_queue" "job_dlq" {
  name                    = "paymyrent-${var.env}-job-dlq"
  sqs_managed_sse_enabled = true
}

resource "aws_iam_role" "events" {
  name = "paymyrent-${var.env}-events-invoke"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow",
    Principal = { Service = "events.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}

resource "aws_iam_role_policy" "events" {
  role = aws_iam_role.events.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = "events:InvokeApiDestination", Resource = [for d in aws_cloudwatch_event_api_destination.job : d.arn] }] })
}

resource "aws_sqs_queue_policy" "job_dlq" {
  queue_url = aws_sqs_queue.job_dlq.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "events.amazonaws.com" },
    Action = "sqs:SendMessage", Resource = aws_sqs_queue.job_dlq.arn }] })
}

resource "aws_cloudwatch_event_target" "job" {
  for_each = local.jobs
  rule     = aws_cloudwatch_event_rule.job[each.key].name
  arn      = aws_cloudwatch_event_api_destination.job[each.key].arn
  role_arn = aws_iam_role.events.arn
  retry_policy {
    maximum_retry_attempts       = 5
    maximum_event_age_in_seconds = 3600
  }
  dead_letter_config { arn = aws_sqs_queue.job_dlq.arn }
}
