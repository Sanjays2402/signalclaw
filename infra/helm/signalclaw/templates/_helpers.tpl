{{/*
Common helpers for the signalclaw chart.
*/}}

{{- define "signalclaw.name" -}}
{{ .Release.Name }}
{{- end -}}

{{- define "signalclaw.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (printf "%s-sa" .Release.Name) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "signalclaw.commonLabels" -}}
app.kubernetes.io/name: signalclaw
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}
