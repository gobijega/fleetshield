# One-time Fleet Shield setup on Fly.io (Sydney): database + app.
# Windows PowerShell version of fly-setup.sh. Run from the repo root after
# `fly auth login`:   powershell -ExecutionPolicy Bypass -File scripts\fly-setup.ps1
$ErrorActionPreference = 'Stop'
$App = 'fleetshield'; $Db = 'fleetshield-db'; $Region = 'syd'

if (-not (Get-Command fly -ErrorAction SilentlyContinue)) { throw 'Install flyctl first: iwr https://fly.io/install.ps1 -useb | iex' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 20+ first: https://nodejs.org' }
fly auth whoami | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Run: fly auth login' }

function Fly([string[]]$a) { & fly @a; if ($LASTEXITCODE -ne 0) { throw "fly $($a -join ' ') failed" } }
function Rand([int]$n) { node -e "console.log(require('crypto').randomBytes($n).toString('hex'))" }

Write-Host "== Database ($Db, $Region) =="
& fly apps create $Db 2>$null; if ($LASTEXITCODE -ne 0) { Write-Host '  app exists' }
if (-not ((& fly volumes list -a $Db 2>$null) -match 'pgdata')) {
  Fly @('volumes','create','pgdata','-a',$Db,'-r',$Region,'-s','3','--yes')
}
$NewDbPass = $null
if (-not ((& fly secrets list -a $Db 2>$null) -match 'POSTGRES_PASSWORD')) {
  $NewDbPass = Rand 24
  Fly @('secrets','set','-a',$Db,'--stage',"POSTGRES_PASSWORD=$NewDbPass")
}
Fly @('deploy','-c','fly-db.toml','--ha=false','--yes')

Write-Host "`n== App ($App, $Region) =="
& fly apps create $App 2>$null; if ($LASTEXITCODE -ne 0) { Write-Host '  app exists' }

if ($NewDbPass) {
  $Session = Rand 32
  Fly @('secrets','set','-a',$App,'--stage',
    "DATABASE_URL=postgres://fleetshield:$NewDbPass@$Db.internal:5432/fleetshield",
    'PGSSL=disable', "SESSION_SECRET=$Session")
}

if (-not ((& fly secrets list -a $App 2>$null) -match 'ADMIN_PASSWORD_HASH')) {
  $User = Read-Host 'Admin username'
  $Sec = Read-Host 'Admin password (12+ chars)' -AsSecureString
  $Pass = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($Sec))
  if (-not (Test-Path node_modules)) { npm install --silent }
  $env:FS_PW = $Pass
  $Hash = node -e "console.log(require('bcryptjs').hashSync(process.env.FS_PW, 12))"
  Remove-Item Env:FS_PW
  Fly @('secrets','set','-a',$App,'--stage',"ADMIN_USERNAME=$User","ADMIN_PASSWORD_HASH=$Hash")
}

# --ha=false: exactly ONE app machine (simulator + WebSocket feed are in-process)
Fly @('deploy','--ha=false','--yes')

Write-Host "`nDone. Check: https://$App.fly.dev/api/health  (expect {`"ok`":true,`"db`":`"connected`"})"
Write-Host "Then point fleetshield.systems at it: fly certs add fleetshield.systems -a $App"
