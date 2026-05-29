terraform {
  required_version = ">= 1.5"
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.30" }
    helm       = { source = "hashicorp/helm",       version = "~> 2.13" }
  }
}

variable "namespace" { default = "signalclaw" }
variable "api_key"   { default = "change-me", sensitive = true }

resource "kubernetes_namespace" "ns" {
  metadata { name = var.namespace }
}

resource "helm_release" "signalclaw" {
  name       = "signalclaw"
  namespace  = kubernetes_namespace.ns.metadata[0].name
  chart      = "../helm/signalclaw"
  values     = [file("values.yaml")]
  set_sensitive { name = "api.apiKey" value = var.api_key }
}
