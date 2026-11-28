param(
  [Parameter(Mandatory)][ValidateSet('up','down','status','seed','logs','prune','backup','restore')][string]$Action,
  [Parameter(Mandatory)][string]$EnvFile,
  [ValidatePattern('^nri-acceptance-[a-z0-9-]+$')][string]$Project = 'nri-acceptance-local',
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$')][string]$BackupName
)

$ErrorActionPreference = 'Stop'
$configFile = (Resolve-Path -LiteralPath $EnvFile).Path
$repo = Split-Path -Parent $PSScriptRoot
$previousEnvironment = @{}
foreach ($name in @('NRI_HTTPS_BIND','UPLOAD_DIR','DATABASE_URL','NRI_BACKUP_DB_CONTAINER','NODE_EXTRA_CA_CERTS')) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
}
Push-Location -LiteralPath $repo
try {
  $prefix = @('compose', '--env-file', $configFile, '-p', $Project, '-f', 'docker-compose.production.yml', '-f', 'deploy/testing/compose.acceptance.yml')
  function Invoke-Docker([string[]]$Arguments) {
    docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Docker command failed. Check the isolated project and its service status.' }
  }
  $env:NRI_HTTPS_BIND = '127.0.0.1'
  $raw = Invoke-Docker ($prefix + @('config','--format','json'))
  try { $config = ($raw -join "`n") | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Compose configuration could not be read.' }
  $apiConfig = $config.services.api.environment
  $url = [Uri]$apiConfig.WEB_ORIGIN
  $port = $config.services.proxy.ports[0]
  if ($url.Scheme -ne 'https' -or $url.Host -ne '127.0.0.1' -or $port.host_ip -ne '127.0.0.1' -or $url.Port -ne $port.published -or $config.services.db.ports) {
    throw 'The acceptance stand requires a loopback HTTPS origin and an unexposed database.'
  }
  if ($Action -in @('backup','restore') -and -not $BackupName) { throw 'Specify -BackupName.' }
  $db = "$Project-db-1"
  $api = "$Project-api-1"
  switch ($Action) {
    'up' {
      Invoke-Docker ($prefix + @('build','api','proxy'))
      Invoke-Docker ($prefix + @('--profile','maintenance','run','--rm','migrate'))
      Invoke-Docker ($prefix + @('up','-d','--wait','api','proxy'))
    }
    'down' { Invoke-Docker ($prefix + @('down')) }
    'status' {
      Invoke-Docker ($prefix + @('ps'))
      $ca = Join-Path $config.services.proxy.volumes[0].source 'ca.pem'
      if (Test-Path -LiteralPath $ca) { $env:NODE_EXTRA_CA_CERTS = $ca }
      node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(8000)}).then(async r=>{if(!r.ok)process.exitCode=1;console.log(await r.text())}).catch(()=>{console.error("HTTPS readiness probe failed");process.exitCode=1})' ($url.GetLeftPart([UriPartial]::Authority) + '/api/ready')
      if ($LASTEXITCODE -ne 0) { throw 'The trusted HTTPS readiness check failed.' }
    }
    'seed' {
      if ($env:DEMO_PASSWORD.Length -lt 12) { throw 'Set a disposable DEMO_PASSWORD of at least 12 characters in this process.' }
      Invoke-Docker ($prefix + @('run','--rm','-e','DEMO_PASSWORD','api','node','dist/seed.js'))
      Invoke-Docker ($prefix + @('run','--rm','-e','NODE_ENV=test','-e','NRI_ACCEPTANCE_DEMO=1','api','node','dist/seedPlayableAmber.js'))
    }
    'logs' { Invoke-Docker ($prefix + @('logs','--tail','100','api','db','proxy')) }
    'prune' { Invoke-Docker ($prefix + @('--profile','maintenance','run','--rm','migrate','node','scripts/prune-operation-receipts.mjs')) }
    'backup' {
      if (Test-Path -LiteralPath (Join-Path '.backups' $BackupName)) { throw 'The backup destination already exists.' }
      Invoke-Docker ($prefix + @('stop','proxy','api'))
      $snapshot = New-Item -ItemType Directory -Path (Join-Path '.data' ("$Project-media-" + [guid]::NewGuid().ToString('N')))
      Invoke-Docker @('cp', "${api}:/app/.data/uploads/.", $snapshot.FullName)
      $env:UPLOAD_DIR = $snapshot.FullName
      $env:DATABASE_URL = $apiConfig.DATABASE_URL
      $env:NRI_BACKUP_DB_CONTAINER = $db
      node scripts/backup.mjs create $BackupName
      if ($LASTEXITCODE -ne 0) { throw 'Backup creation failed. Writers are still stopped.' }
      node scripts/backup.mjs verify $BackupName
      if ($LASTEXITCODE -ne 0) { throw 'Backup verification failed. Writers are still stopped.' }
      Write-Output 'Backup verified. Restart the original stand with the up action after the maintenance window.'
    }
    'restore' {
      node scripts/backup.mjs verify $BackupName
      if ($LASTEXITCODE -ne 0) { throw 'Backup verification failed.' }
      if ((Invoke-Docker ($prefix + @('ps','-a','-q'))) -or (Invoke-Docker @('volume','ls','--filter',"label=com.docker.compose.project=$Project",'-q'))) {
        throw 'Restore requires a new Compose project with no containers or volumes.'
      }
      $backup = (Resolve-Path -LiteralPath (Join-Path '.backups' $BackupName)).Path
      $dbConfig = $config.services.db.environment
      $dbName = $dbConfig.POSTGRES_DB
      $dbUser = $dbConfig.POSTGRES_USER
      Invoke-Docker ($prefix + @('up','-d','--wait','db'))
      Invoke-Docker @('cp', (Join-Path $backup 'database.dump'), "${db}:/tmp/nri-restore.dump")
      Invoke-Docker @('exec',$db,'pg_restore','--no-owner','--no-privileges','--exit-on-error','--single-transaction','-U',$dbUser,'-d',$dbName,'/tmp/nri-restore.dump')
      Invoke-Docker @('exec',$db,'rm','--','/tmp/nri-restore.dump')
      $media = Join-Path $backup 'uploads'
      Invoke-Docker ($prefix + @('run','--no-deps','--rm','--user','root','-v',"${media}:/restore:ro",'api','sh','-ec',
        'test -z "$(ls -A /app/.data/uploads)"; cp -a /restore/. /app/.data/uploads/; chown -R node:node /app/.data/uploads'))
      Invoke-Docker ($prefix + @('up','-d','--wait','api','proxy'))
    }
  }
} finally {
  foreach ($name in $previousEnvironment.Keys) {
    if ($null -eq $previousEnvironment[$name]) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
  }
  Pop-Location
}
