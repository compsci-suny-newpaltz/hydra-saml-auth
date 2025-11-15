# PowerShell script to normalize Git line endings to LF
# Run from the repo root in PowerShell as: .\dev\normalize-eol.ps1

$ErrorActionPreference = 'Stop'
$gitRoot = & git rev-parse --show-toplevel
Set-Location $gitRoot

Write-Host "Setting core.autocrlf to false"
& git config core.autocrlf false

Write-Host "Removing files from index (won't delete them)"
& git rm --cached -r .

Write-Host "Re-adding files with renormalize"
& git add --renormalize .

# Check if there are staged changes
$diff = (& git diff --staged --name-only)
if ($diff) {
    Write-Host "Committing normalized files"
    & git commit -m "Normalize line endings to LF"
    Write-Host "Normalization committed."
} else {
    Write-Host "No changes after renormalization. Nothing to commit."
}

Write-Host "Done. Current git status:"
& git status --porcelain
