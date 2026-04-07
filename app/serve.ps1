$port = if ($env:PORT) { $env:PORT } else { '3456' }
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Listening on port $port"
$root = $PSScriptRoot
$apiKey = 'ba708e43dcee47f48913f88294f1e0f2'

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $path = $ctx.Request.Url.LocalPath
    $query = $ctx.Request.Url.Query

    if ($path.StartsWith('/api/')) {
        # Proxy to football-data.org
        $apiPath = $path.Substring(4) # strip /api
        $url = "https://api.football-data.org/v4$apiPath$query"
        try {
            $headers = @{ 'X-Auth-Token' = $apiKey }
            $response = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -ErrorAction Stop
            $json = $response | ConvertTo-Json -Depth 20 -Compress
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
            $ctx.Response.ContentType = 'application/json; charset=utf-8'
            $ctx.Response.AddHeader('Access-Control-Allow-Origin', '*')
            $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        } catch {
            $errMsg = '{"error":"' + $_.Exception.Message.Replace('"','\"') + '"}'
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($errMsg)
            $ctx.Response.StatusCode = 502
            $ctx.Response.ContentType = 'application/json; charset=utf-8'
            $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        }
    } else {
        # Serve static files
        if ($path -eq '/') { $path = '/index.html' }
        $file = Join-Path $root $path.TrimStart('/')
        if (Test-Path $file) {
            $bytes = [System.IO.File]::ReadAllBytes($file)
            $ext = [System.IO.Path]::GetExtension($file)
            $ct = switch ($ext) {
                '.html' { 'text/html; charset=utf-8' }
                '.css'  { 'text/css; charset=utf-8' }
                '.js'   { 'application/javascript; charset=utf-8' }
                default { 'application/octet-stream' }
            }
            $ctx.Response.ContentType = $ct
            $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $ctx.Response.StatusCode = 404
        }
    }
    $ctx.Response.Close()
}
