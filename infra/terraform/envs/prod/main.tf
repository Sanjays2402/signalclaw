module "signalclaw" {
  source     = "../../"
  namespace  = "signalclaw-prod"
  api_key    = var.api_key
}
variable "api_key" { sensitive = true }
