module "signalclaw" {
  source     = "../../"
  namespace  = "signalclaw-dev"
  api_key    = var.api_key
}
variable "api_key" { sensitive = true }
