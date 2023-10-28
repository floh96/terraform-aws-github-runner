# specif for this module

variable "lambda_schedule_expression" {
  description = "Scheduler expression for action runner binary syncer."
  type        = string
  default     = "cron(11 7 * * ? *)" # once a day
}

variable "ami_cleanup_config" {
  description = "Configuration for AMI cleanup."
  type = object({
    maxItems       = optional(number)
    minimumDaysOld = optional(number)
    amiFilters = optional(list(object({
      Name   = string
      Values = list(string)
    })))
    launchTemplateNames = optional(list(string))
    ssmParameterNames   = optional(list(string))
    dryRun              = optional(bool)
  })
  default = {}
}
