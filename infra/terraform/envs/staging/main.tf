module "signalclaw" {
  source     = "../../"
  namespace  = "signalclaw-staging"
  api_key    = var.api_key
}
variable "api_key" { sensitive = true }
