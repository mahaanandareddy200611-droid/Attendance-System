$ErrorActionPreference = 'Stop'
$script:releaseSmokePromptedSecrets = @()
$script:releaseSmokeFailures = @()

function Get-ConfiguredValue {
    param(
        [Parameter(Mandatory=$true)][string]$Name,
        [Parameter(Mandatory=$true)][string]$Prompt,
        [switch]$Secret,
        [switch]$Optional
    )
    $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }

    if ($Secret) {
        $secure = Read-Host -Prompt $Prompt -AsSecureString
        $pointer = [IntPtr]::Zero
        try {
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        } finally {
            if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
            if ($null -ne $secure) { $secure.Dispose() }
        }
    } else {
        $value = Read-Host -Prompt $Prompt
    }

    if ([string]::IsNullOrWhiteSpace($value)) {
        if ($Optional) {
            Remove-Item -Path "Env:$Name" -ErrorAction SilentlyContinue
            return ''
        }
        throw "Required value '$Name' was not supplied."
    }
    Set-Item -Path "Env:$Name" -Value $value
    if ($Secret) { $script:releaseSmokePromptedSecrets += $Name }
    return $value
}

function Invoke-NpmSmoke {
    param([Parameter(Mandatory=$true)][string]$Name)
    Write-Host "`n=== $Name ==="
    & npm run $Name
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Write-Warning "FAIL: '$Name' exited with code $exitCode. Continuing so the remaining independent checks still run."
        $script:releaseSmokeFailures += [pscustomobject]@{ Name = $Name; ExitCode = $exitCode }
        return $false
    }
    Write-Host "PASS: $Name"
    return $true
}

Write-Host 'This runner performs real external actions:'
Write-Host '  - uploads and permanently deletes a temporary Backblaze B2 object and all versions;'
Write-Host '  - sends a non-sensitive email;'
Write-Host '  - verifies the live backend, creates/checks an empty biometric collection, enrolls/deletes a temporary test identity;'
Write-Host '  - resets the password of a dedicated staging test account using its real inbox OTP.'
Write-Host 'Use only a bucket-scoped test key, a consenting non-student test subject, and a disposable staging account.'
if ((Read-Host 'Type RUN-STAGING-ACCEPTANCE to continue') -cne 'RUN-STAGING-ACCEPTANCE') { throw 'Acceptance run cancelled before any external request.' }

$backendDir = Split-Path -Parent $PSScriptRoot
$secretVariableNames = @(
    'OBJECT_STORAGE_ACCESS_KEY_ID', 'OBJECT_STORAGE_SECRET_ACCESS_KEY',
    'MAIL_PASSWORD', 'BIOMETRIC_API_KEY',
    'AUTH_RECOVERY_CURRENT_PASSWORD', 'AUTH_RECOVERY_NEW_PASSWORD'
)
$sensitiveLocals = @()
Push-Location $backendDir
try {
    $null = Get-ConfiguredValue -Name 'STAGING_BASE_URL' -Prompt 'Deployed backend URL (HTTPS origin or URL ending /api/v1)'
    $null = Get-ConfiguredValue -Name 'LECTURER_WEB_BASE_URL' -Prompt 'Deployed lecturer web HTTPS origin'
    $null = Get-ConfiguredValue -Name 'OBJECT_STORAGE_ENDPOINT' -Prompt 'Backblaze B2 S3 endpoint, e.g. https://s3.us-east-005.backblazeb2.com'
    $null = Get-ConfiguredValue -Name 'OBJECT_STORAGE_BUCKET' -Prompt 'Private B2 bucket name'
    $null = Get-ConfiguredValue -Name 'OBJECT_STORAGE_REGION' -Prompt 'B2 region, e.g. us-east-005'
    $storageAccessKey = Get-ConfiguredValue -Name 'OBJECT_STORAGE_ACCESS_KEY_ID' -Prompt 'Bucket-scoped B2 application key ID' -Secret
    $storageSecretKey = Get-ConfiguredValue -Name 'OBJECT_STORAGE_SECRET_ACCESS_KEY' -Prompt 'Bucket-scoped B2 application key secret' -Secret
    $sensitiveLocals += 'storageAccessKey','storageSecretKey'
    $null = Get-ConfiguredValue -Name 'MAIL_SMOKE_TO' -Prompt 'Inbox to receive the delivery test'
    $null = Get-ConfiguredValue -Name 'MAIL_USER' -Prompt 'SMTP sender/account username'
    $mailPassword = Get-ConfiguredValue -Name 'MAIL_PASSWORD' -Prompt 'SMTP sender/app password' -Secret
    $sensitiveLocals += 'mailPassword'
    $mailHost = Get-ConfiguredValue -Name 'MAIL_HOST' -Prompt 'SMTP host (press Enter for legacy Gmail transport)' -Optional
    if (-not [string]::IsNullOrWhiteSpace($mailHost)) {
        $null = Get-ConfiguredValue -Name 'MAIL_PORT' -Prompt 'SMTP TCP port (465 for implicit TLS or 587 for STARTTLS)'
        $null = Get-ConfiguredValue -Name 'MAIL_SECURE' -Prompt 'MAIL_SECURE true/false (true for port 465; usually false for 587)' -Optional
    } else {
        Remove-Item Env:MAIL_PORT -ErrorAction SilentlyContinue
        Remove-Item Env:MAIL_SECURE -ErrorAction SilentlyContinue
    }
    $null = Get-ConfiguredValue -Name 'BIOMETRIC_BASE_URL' -Prompt 'Deployed biometric provider HTTPS origin'
    $biometricKey = Get-ConfiguredValue -Name 'BIOMETRIC_API_KEY' -Prompt 'Provider API key (must match Render INSIGHTFACE_API_KEY)' -Secret
    $sensitiveLocals += 'biometricKey'
    $null = Get-ConfiguredValue -Name 'BIOMETRIC_SMOKE_ENROLL_IMAGE_PATH' -Prompt 'Local path to first consenting test-subject face capture'
    $null = Get-ConfiguredValue -Name 'BIOMETRIC_SMOKE_VERIFY_IMAGE_PATH' -Prompt 'Local path to a different capture of the same consenting test subject'
    $null = Get-ConfiguredValue -Name 'AUTH_RECOVERY_TEST_EMAIL' -Prompt 'Dedicated staging account email (must be accessible in your inbox)'
    $recoveryCurrentPassword = Get-ConfiguredValue -Name 'AUTH_RECOVERY_CURRENT_PASSWORD' -Prompt 'Current password of that staging account' -Secret
    $recoveryNewPassword = Get-ConfiguredValue -Name 'AUTH_RECOVERY_NEW_PASSWORD' -Prompt 'New password to set for that staging account' -Secret
    $sensitiveLocals += 'recoveryCurrentPassword','recoveryNewPassword'

    if ($recoveryNewPassword.Length -lt 12 -or $recoveryNewPassword -ceq $recoveryCurrentPassword) {
        throw 'The new staging-account password must be different and at least 12 characters.'
    }
    foreach ($imageName in @('BIOMETRIC_SMOKE_ENROLL_IMAGE_PATH','BIOMETRIC_SMOKE_VERIFY_IMAGE_PATH')) {
        $imagePath = [Environment]::GetEnvironmentVariable($imageName, 'Process')
        if (-not (Test-Path -LiteralPath $imagePath -PathType Leaf)) { throw "$imageName does not point to an existing local file." }
    }

    $env:OBJECT_STORAGE_PURGE_VERSIONS = 'true'
    $env:ATTENDANCE_REQUIRE_BIOMETRIC = 'true'
    if ([string]::IsNullOrWhiteSpace($env:BIOMETRIC_COLLECTION_ID)) { $env:BIOMETRIC_COLLECTION_ID = 'students' }

    Write-Host '`nInstalling exact backend lockfile dependencies...'
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }

    Invoke-NpmSmoke 'smoke:deployment'
    Invoke-NpmSmoke 'storage:smoke'
    Invoke-NpmSmoke 'mail:smoke'
    Invoke-NpmSmoke 'biometric:bootstrap'
    Invoke-NpmSmoke 'biometric:smoke'
    Invoke-NpmSmoke 'password-recovery:smoke'

    if ($script:releaseSmokeFailures.Count -gt 0) {
        Write-Host "`n=== STAGING ACCEPTANCE SUMMARY: FAILURES DETECTED ===" -ForegroundColor Yellow
        foreach ($failure in $script:releaseSmokeFailures) {
            Write-Host ("FAIL: {0} (exit {1})" -f $failure.Name, $failure.ExitCode)
        }
        Write-Host ("Completed {0} checks; {1} failed." -f 6, $script:releaseSmokeFailures.Count)
        throw 'One or more external staging checks failed. Review the results above; all independent checks were attempted.'
    }

    Write-Host "`nALL CONFIGURED STAGING SMOKES PASSED." -ForegroundColor Green
    Write-Host 'Save the newly selected test-account password securely. No live student biometrics were required.'
} finally {
    Pop-Location
    foreach ($name in $script:releaseSmokePromptedSecrets) { Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue }
    foreach ($name in $sensitiveLocals) { Remove-Variable -Name $name -Scope Script -ErrorAction SilentlyContinue }
}
