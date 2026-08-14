param(
  [switch]$Install,
  [switch]$NativeHost
)

$ErrorActionPreference = "Stop"
$HostName = "com.clouddrive2.offline"
$ExtensionId = "pafaiigiceklmpecemghfnpimjhlgmpd"
$ChromeKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$EdgeKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"

function Write-NativeMessage([hashtable]$Value) {
  $payload = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Compress))
  $output = [Console]::OpenStandardOutput()
  $header = [BitConverter]::GetBytes([uint32]$payload.Length)
  $output.Write($header, 0, $header.Length)
  $output.Write($payload, 0, $payload.Length)
  $output.Flush()
}

function Read-NativeMessage {
  $inputStream = [Console]::OpenStandardInput()
  $header = New-Object byte[] 4
  $headerLength = $inputStream.Read($header, 0, 4)
  if ($headerLength -eq 0) { return $null }
  if ($headerLength -ne 4) { throw "incomplete message header" }
  $length = [BitConverter]::ToUInt32($header, 0)
  if ($length -eq 0 -or $length -gt 1048576) { throw "invalid message size" }
  $payload = New-Object byte[] $length
  $offset = 0
  while ($offset -lt $length) {
    $read = $inputStream.Read($payload, $offset, $length - $offset)
    if ($read -le 0) { throw "incomplete message body" }
    $offset += $read
  }
  return [Text.Encoding]::UTF8.GetString($payload) | ConvertFrom-Json
}

function Install-Host {
  $launcherPath = Join-Path $PSScriptRoot "clouddrive2-native-host-run.cmd"
  $launcher = @'
@echo off
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0clouddrive2-native-host.ps1" -NativeHost
exit /b %errorlevel%
'@
  [IO.File]::WriteAllText($launcherPath, $launcher.Trim() + "`r`n", [Text.Encoding]::ASCII)
  $manifestPath = Join-Path $PSScriptRoot "$HostName.json"
  $manifest = @{
    name = $HostName
    description = "CloudDrive2 Offline local folder helper"
    path = $launcherPath
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
  } | ConvertTo-Json -Depth 3
  [IO.File]::WriteAllText($manifestPath, $manifest, [Text.UTF8Encoding]::new($false))
  foreach ($key in @($ChromeKey, $EdgeKey)) {
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $manifestPath
    if ((Get-Item -Path $key).GetValue("") -ne $manifestPath) {
      throw "native messaging registry verification failed: $key"
    }
  }
  if (-not (Test-Path -LiteralPath $manifestPath) -or -not (Test-Path -LiteralPath $launcherPath)) {
    throw "native messaging host files verification failed"
  }
}

function Uninstall-Host {
  foreach ($key in @($ChromeKey, $EdgeKey)) {
    if (Test-Path $key) { Remove-Item -Path $key -Force }
  }
  $manifestPath = Join-Path $PSScriptRoot "$HostName.json"
  if (Test-Path -LiteralPath $manifestPath) { Remove-Item -LiteralPath $manifestPath -Force }
  $launcherPath = Join-Path $PSScriptRoot "clouddrive2-native-host-run.cmd"
  if (Test-Path -LiteralPath $launcherPath) { Remove-Item -LiteralPath $launcherPath -Force }
}

function Find-PotPlayer {
  $registryPaths = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\PotPlayerMini64.exe",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\PotPlayerMini.exe",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\PotPlayerMini64.exe",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\PotPlayerMini.exe",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\PotPlayerMini.exe"
  )
  foreach ($registryPath in $registryPaths) {
    try {
      $candidate = [string](Get-Item -LiteralPath $registryPath -ErrorAction Stop).GetValue("")
      if ($candidate -and [IO.File]::Exists($candidate)) { return $candidate }
    } catch {}
  }
  $candidates = @(
    (Join-Path $env:ProgramFiles "DAUM\PotPlayer\PotPlayerMini64.exe"),
    (Join-Path $env:ProgramFiles "PotPlayer\PotPlayerMini64.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "DAUM\PotPlayer\PotPlayerMini.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "PotPlayer\PotPlayerMini.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and [IO.File]::Exists($candidate)) { return $candidate }
  }
  throw "PotPlayer executable was not found"
}

function Start-PotPlayerPlaylist($Request) {
  $entries = @($Request.entries)
  if ($entries.Count -eq 0 -or $entries.Count -gt 500) {
    throw "playlist must contain between 1 and 500 entries"
  }
  $lines = [Collections.Generic.List[string]]::new()
  $lines.Add("DAUMPLAYLIST")
  $startUrl = [string]$Request.startUrl
  if ($startUrl.Contains("`r") -or $startUrl.Contains("`n") -or
      -not ($entries | Where-Object { [string]$_.url -eq $startUrl })) {
    throw "playlist start URL must match an entry"
  }
  $lines.Add("playname=$startUrl")
  $lines.Add("playtime=0")
  $lines.Add("topindex=0")
  $lines.Add("saveplaypos=0")
  for ($index = 0; $index -lt $entries.Count; $index++) {
    $url = [string]$entries[$index].url
    $uri = $null
    if ($url.Contains("`r") -or $url.Contains("`n") -or
        -not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri) -or
        ($uri.Scheme -ne "http" -and $uri.Scheme -ne "https")) {
      throw "playlist entry URL must be an absolute HTTP(S) URL"
    }
    $fileName = ([string]$entries[$index].fileName).Replace("`r", " ").Replace("`n", " ").Replace("*", "＊")
    if ([string]::IsNullOrWhiteSpace($fileName)) { $fileName = "Video $($index + 1)" }
    $dplIndex = $index + 1
    $lines.Add("$dplIndex*file*$url")
    $lines.Add("$dplIndex*title*$fileName")
    $lines.Add("$dplIndex*played*0")
  }
  $playlistDirectory = Join-Path ([IO.Path]::GetTempPath()) "clouddrive2-offline"
  [IO.Directory]::CreateDirectory($playlistDirectory) | Out-Null
  Get-ChildItem -LiteralPath $playlistDirectory -Filter "*.dpl" -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-1) } |
    Remove-Item -Force -ErrorAction SilentlyContinue
  $playlistPath = Join-Path $playlistDirectory ("playlist-" + [Guid]::NewGuid().ToString("N") + ".dpl")
  [IO.File]::WriteAllLines($playlistPath, $lines, [Text.UTF8Encoding]::new($true))
  $potPlayer = Find-PotPlayer
  Start-Process -FilePath $potPlayer -ArgumentList ('"' + $playlistPath.Replace('"', '') + '"'), "/new"
  return $playlistPath
}

if ($Install) {
  Install-Host
  exit 0
}

if (-not $NativeHost) { exit 1 }

while ($true) {
  try {
    $request = Read-NativeMessage
    if ($null -eq $request) { break }
    $response = @{ ok = $false }
    $shouldExit = $false
    if ($request.requestId) { $response.requestId = [string]$request.requestId }
    try {
      switch ($request.action) {
        "ping" {
          $response.ok = $true
          $response.kind = "powershell"
          $response.protocol = 8
        }
        "uninstall" {
          Uninstall-Host
          $response.ok = $true
          $shouldExit = $true
        }
        "openDirectory" {
          $path = [string]$request.path
          if (-not [IO.Path]::IsPathRooted($path)) { throw "path must be absolute" }
          if ([IO.Directory]::Exists($path)) {
            $directory = $path
          } elseif ([IO.File]::Exists($path)) {
            $directory = [IO.Path]::GetDirectoryName($path)
          } else {
            throw "path is not an existing file or directory"
          }
          $quotedPath = '"' + $directory.Replace('"', '') + '"'
          Start-Process -FilePath "explorer.exe" -ArgumentList $quotedPath
          $response.ok = $true
        }
        "revealPath" {
          $path = [string]$request.path
          if (-not [IO.Path]::IsPathRooted($path)) { throw "path must be absolute" }
          if ([IO.File]::Exists($path)) {
            $quotedPath = $path.Replace('"', '')
            Start-Process -FilePath "explorer.exe" -ArgumentList ('/select,"' + $quotedPath + '"')
          } elseif ([IO.Directory]::Exists($path)) {
            $quotedPath = '"' + $path.Replace('"', '') + '"'
            Start-Process -FilePath "explorer.exe" -ArgumentList $quotedPath
          } else {
            throw "path is not an existing file or directory"
          }
          $response.ok = $true
        }
        "playPotPlayerPlaylist" {
          $response.playlistPath = Start-PotPlayerPlaylist $request
          $response.ok = $true
        }
        default { throw "unsupported action" }
      }
    } catch {
      $response.error = $_.Exception.Message
    }
    Write-NativeMessage $response
    if ($shouldExit) { break }
  } catch {
    Write-NativeMessage @{ ok = $false; error = $_.Exception.Message }
    break
  }
}
