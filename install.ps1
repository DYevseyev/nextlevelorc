# nextlevel installer: installs, repairs or updates the nextlevel tool on this PC.
#
# Type it in PowerShell (a normal window, not "Run as administrator"), in any folder:
#   irm https://raw.githubusercontent.com/DYevseyev/nextlevelorc/main/install.ps1 | iex
# From a private fork (NEXTLEVEL_REPO) it needs the GitHub CLI, signed in (winget install -e --id GitHub.cli, then in
# a new window: gh auth login):
#   gh api repos/<owner>/<name>/contents/install.ps1 -H "Accept: application/vnd.github.raw" | Out-String | iex
#
# It checks Node.js 22+ and Git (and offers winget for them), keeps the tool in
# %USERPROFILE%\.nextlevel\tool (or the folder NEXTLEVEL_DIR names) as a git clone (made with plain git, or with
# gh when it is signed in; a private fork needs gh) and makes the nextlevel command (%USERPROFILE%\.nextlevel\bin,
# added to your PATH). Since releases (docs/design/safe-updates.md) it installs the newest release, in a folder of
# its own (%USERPROFILE%\.nextlevel\versions\<release>), and the nextlevel command runs the launcher, which runs the
# version each project follows. A clone already there, such as the hand install from before this installer, is taken
# over: it moves to the newest release (to main while no release is published), and the command that npm link made
# for it is replaced. Files changed by hand stop it with the way out; nothing is thrown away. Running it again
# repairs or updates the install, in the folder it was installed in last time.
#
# Options, as environment variables set before running it:
#   NEXTLEVEL_DIR      the folder for the tool, e.g. $env:NEXTLEVEL_DIR = "$env:USERPROFILE\Tools\nextlevel".
#                      An install elsewhere is moved there (with its settings and branch); the nextlevel
#                      command and its updates keep working. The folder must be new or empty.
#   NEXTLEVEL_REF      a release to install instead of the newest (v0.3.0: going back is the owner's choice), or,
#                      while no release is published, a branch or tag (a tag pins the tool)
#   NEXTLEVEL_REPO     owner/name of the repository on GitHub (a fork)
#   NEXTLEVEL_MOVE_FROM  owner/name of the repository the install follows now, to move it to this one (where nextlevel
#                      is published now). Without it, an install that follows another repository is left as it is.
#                      Its versions, the projects pinned to them and its settings stay; field reports keep going to
#                      the repository it leaves (~/.nextlevel/state.json "reports"); the old one stays as the git
#                      remote nextlevel-previous. The owner's, in their own window: an agent's session is refused.
#   NEXTLEVEL_NO_PATH  1: leave PATH alone
#
# Rules for this file (test/install.test.mjs checks the first two): ASCII only (Windows PowerShell reads
# piped text in the console's code page); never exit (run through iex, exit would close the owner's
# window: stop with return); it runs in Windows PowerShell 5.1 and in PowerShell 7 (the tests run it
# with pwsh on Linux as well); and every function result is used or assigned, because in PowerShell
# anything a function leaves unused becomes part of what it returns.
& {
  $ErrorActionPreference = 'Continue'
  $PSNativeCommandUseErrorActionPreference = $false
  $Repo = if ($env:NEXTLEVEL_REPO) { $env:NEXTLEVEL_REPO } else { 'DYevseyev/nextlevelorc' }
  $RepoUrl = "https://github.com/$Repo.git"
  $Ref = $env:NEXTLEVEL_REF
  $OnWindows = $env:OS -eq 'Windows_NT'
  $UserHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
  $Base = Join-Path $UserHome '.nextlevel'
  $DefaultDir = Join-Path $Base 'tool'
  $Bin = Join-Path $Base 'bin'
  $Sep = [IO.Path]::PathSeparator
  $Again = 'Then run the same install command again.'
  $MoveFrom = if ($env:NEXTLEVEL_MOVE_FROM) { $env:NEXTLEVEL_MOVE_FROM.Trim() } else { '' }

  function Stop-With([string]$Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor Yellow
  }
  function Test-Cmd([string]$Name) {
    return [bool](Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue)
  }
  function Ask([string]$Question) {
    try { $a = Read-Host "$Question [Y/n]" } catch { return $false }
    return ($a -eq '' -or $a -match '^\s*[yY]')
  }
  # A program that talks to the owner (winget, gh auth login): in this console, so it can ask and show progress.
  function Run-Here([string]$File, [string[]]$Arguments) {
    try { $p = Start-Process -FilePath $File -ArgumentList $Arguments -NoNewWindow -Wait -PassThru -ErrorAction Stop } catch { Write-Host $_.Exception.Message; return $false }
    return ($p.ExitCode -eq 0)
  }
  # What winget installed is on the PATH of windows opened from now on; bring it into this one.
  function Update-SessionPath {
    if (-not $OnWindows) { return }
    $all = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), $env:Path) -join ';'
    $env:Path = (($all -split ';') | Where-Object { $_ } | Select-Object -Unique) -join ';'
  }
  # git whose output is read here, and git whose output the owner sees.
  function Invoke-Git([string[]]$GitArgs) {
    $out = & git @GitArgs 2>$null
    $ok = ($LASTEXITCODE -eq 0)
    $text = (@($out) | ForEach-Object { "$_" }) -join "`n"
    return [pscustomobject]@{ Ok = $ok; Out = $text.Trim() }
  }
  function Run-Git([string[]]$GitArgs) {
    & git @GitArgs | Out-Host
    return ($LASTEXITCODE -eq 0)
  }
  # git must not ask for a login in a terminal or a pop-up: it fails instead, and this script says what to do.
  function Invoke-NoPrompt([scriptblock]$Block) {
    $saved = @($env:GIT_TERMINAL_PROMPT, $env:GCM_INTERACTIVE)
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'never'
    try { return (& $Block) } finally { $env:GIT_TERMINAL_PROMPT = $saved[0]; $env:GCM_INTERACTIVE = $saved[1] }
  }
  # github.com gets the GitHub CLI's login, the way gh runs git itself (a private fork needs it).
  function Get-AuthArgs {
    $url = (Invoke-Git @('-C', $Dir, 'remote', 'get-url', 'origin')).Out
    if ((Test-Cmd 'gh') -and ($url -match '^https://github\.com/')) { return @('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential') }
    return @()
  }
  function Test-SameRepo([string]$Url) {
    $u = $Url.Trim() -replace '\.git$', '' -replace '/$', ''
    return ($u -match ('github\.com[:/]' + [regex]::Escape($Repo) + '$'))
  }
  # owner/name of a GitHub URL, or ''
  function Get-Slug([string]$Url) {
    $u = $Url.Trim() -replace '/$', '' -replace '\.git$', ''
    if ($u -match 'github\.com[:/]([\w.-]+/[\w.-]+)$') { return $Matches[1] }
    return ''
  }
  # What the hub puts in an agent's environment (src/lib/session.mjs): moving the install is the owner's
  function Test-Agent {
    return [bool](($env:NEXTLEVEL_READ_ONLY -eq '1') -or $env:NEXTLEVEL_SESSION -or $env:NEXTLEVEL_TASK_ID -or $env:NEXTLEVEL_AGENT)
  }
  # The clone in $Folder follows $Repo, or is moved to it now because the owner named the repository it follows in
  # NEXTLEVEL_MOVE_FROM. The old one stays as the remote nextlevel-previous, which is how `nextlevel _install` knows, now
  # or at a later run, and keeps what the install had (src/lib/install.mjs keepWhatMoved).
  function Confirm-Origin([string]$Folder) {
    # the URL as configured: `git remote get-url` would show it after url.<base>.insteadOf rewrites it
    $url = (Invoke-Git @('-C', $Folder, 'config', '--get', 'remote.origin.url')).Out
    if (Test-SameRepo $url) { return $true }
    $from = Get-Slug $url
    if (-not $MoveFrom) {
      if ($from) {
        Stop-With "$Folder is a clone of $url, not of $Repo. To move this install to $Repo (its versions, the projects that use them and its settings stay), type in this window: `$env:NEXTLEVEL_MOVE_FROM = '$from'   $Again"
      } else {
        Stop-With "$Folder is a clone of $url, not of $Repo. Move that folder somewhere else (or set NEXTLEVEL_REPO). $Again"
      }
      return $false
    }
    if (-not $from -or ($from.ToLowerInvariant() -ne $MoveFrom.ToLowerInvariant())) {
      Stop-With "NEXTLEVEL_MOVE_FROM is $MoveFrom, but $Folder follows ${url}: nothing was changed. Set it to the repository the install follows now, or remove it (Remove-Item Env:NEXTLEVEL_MOVE_FROM)."
      return $false
    }
    if (Test-Agent) {
      Stop-With 'Moving the install to another repository is the owner''s, and this window is an agent''s session: nothing was changed. The owner runs the install command in their own PowerShell window.'
      return $false
    }
    if ((Invoke-Git @('-C', $Folder, 'config', '--get', 'remote.nextlevel-previous.url')).Ok) {
      $null = Invoke-Git @('-C', $Folder, 'remote', 'remove', 'nextlevel-previous')
    }
    if (-not (Run-Git @('-C', $Folder, 'remote', 'rename', 'origin', 'nextlevel-previous'))) {
      Stop-With "Couldn't set $Repo as the repository of $Folder (git said why above). $Again"
      return $false
    }
    if (-not (Run-Git @('-C', $Folder, 'remote', 'add', 'origin', $RepoUrl))) {
      $null = Invoke-Git @('-C', $Folder, 'remote', 'rename', 'nextlevel-previous', 'origin')
      Stop-With "Couldn't set $Repo as the repository of $Folder (git said why above): it follows $from as before. $Again"
      return $false
    }
    Write-Host "This install follows $Repo from now on (it followed $from, kept as the git remote nextlevel-previous)."
    return $true
  }

  # Where nextlevel was installed last time: `nextlevel _install` keeps it in ~/.nextlevel/state.json.
  function Get-RememberedDir {
    $file = Join-Path $Base 'state.json'
    if (-not (Test-Path -LiteralPath $file)) { return '' }
    try { $state = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json } catch { return '' }
    if ($state -and $state.tool -and $state.tool.dir) { return [string]$state.tool.dir }
    return ''
  }
  function Test-Clone([string]$Folder) {
    return ($Folder -and (Test-Path -LiteralPath (Join-Path $Folder '.git')))
  }
  # The long form of a path with short 8.3 names in it (C:\Users\RUNNER~1\x -> C:\Users\runneradmin\x): Windows
  # keeps those short names, the same folder can be written both ways, and GetFullPath expands them in Windows
  # PowerShell 5.1 but not in PowerShell 7. Windows' own GetLongPathName does it; only the part of the path that
  # exists can be looked up, so the rest is kept as it is. Anything that goes wrong leaves the path as given.
  function Get-LongPath([string]$Path) {
    if (-not $OnWindows -or -not $Path -or -not $Path.Contains('~')) { return $Path }
    try {
      if (-not ('NextlevelLongPath' -as [type])) {
        Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
using System.Text;
public static class NextlevelLongPath {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  private static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint size);
  public static string Of(string path) {
    StringBuilder buffer = new StringBuilder(32768);
    uint n = GetLongPathNameW(path, buffer, (uint)buffer.Capacity);
    return (n > 0 && n < buffer.Capacity) ? buffer.ToString() : null;
  }
}
'@
      }
      $head = $Path.TrimEnd('\', '/')
      $tail = @()
      while ($head -and -not (Test-Path -LiteralPath $head)) {
        $tail = @(Split-Path -Leaf $head) + $tail
        $head = Split-Path -Parent $head
      }
      if (-not $head) { return $Path }
      $long = [NextlevelLongPath]::Of($head)
      if (-not $long) { return $Path }
      foreach ($part in $tail) { $long = Join-Path $long $part }
      return $long
    } catch { return $Path }
  }
  # A process's command line with the paths in it in their long form: a node.exe started from a short name has
  # that name in its command line.
  function Get-LongCommandLine([string]$Line) {
    if (-not $Line -or -not $Line.Contains('~')) { return $Line }
    $parts = foreach ($m in [regex]::Matches($Line, '"[^"]*"|[^\s"]+')) {
      $word = $m.Value.Trim('"')
      if ($word.Contains('~') -and ($word -match '^([A-Za-z]:|\\\\)')) { Get-LongPath $word } else { $word }
    }
    return (@($parts) -join ' ')
  }
  function Get-FullPath([string]$Folder) {
    $full = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Folder)).TrimEnd('\', '/')
    return (Get-LongPath $full)
  }
  function Test-SamePath([string]$A, [string]$B) {
    if ($OnWindows) { return ($A.ToLowerInvariant() -eq $B.ToLowerInvariant()) }
    return ($A -eq $B)
  }
  function Test-Inside([string]$Child, [string]$Parent) {
    $c = $Child + [IO.Path]::DirectorySeparatorChar
    $p = $Parent + [IO.Path]::DirectorySeparatorChar
    if ($OnWindows) { return $c.ToLowerInvariant().StartsWith($p.ToLowerInvariant()) }
    return $c.StartsWith($p)
  }

  # Move the install from $From to $Dir: the same clone, with its branch and anything kept in it. Its git
  # worktrees (nextlevel fix --local) are told where it went. Nothing is deleted: when it can't be moved
  # (another drive, a file in use), a fresh clone goes to $Dir and the old folder stays, unused.
  function Move-Tool([string]$From) {
    if ((Test-Inside $Dir $From) -or (Test-Inside $From $Dir)) {
      Stop-With "$Dir and $From are inside each other: choose a folder next to the old one, not in it. $Again"
      return 'stop'
    }
    $parent = Split-Path -Parent $Dir
    if ($parent) { $null = New-Item -ItemType Directory -Force -Path $parent }
    if (Test-Path -LiteralPath $Dir) { Remove-Item -LiteralPath $Dir -Force -ErrorAction SilentlyContinue }
    try {
      Move-Item -LiteralPath $From -Destination $Dir -ErrorAction Stop
    } catch {
      Write-Host "Couldn't move $From to $Dir ($($_.Exception.Message)): making a fresh copy there instead; the old folder stays as it is, unused."
      return 'copy'
    }
    $null = Invoke-Git @('-C', $Dir, 'worktree', 'repair')
    Write-Host "Moved nextlevel from $From to $Dir."
    return 'moved'
  }

  function Get-NodeMajor {
    if (-not (Test-Cmd 'node')) { return 0 }
    $v = ((& node --version 2>$null) | Out-String).Trim()
    if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
    return 0
  }
  function Confirm-Node {
    $major = Get-NodeMajor
    if ($major -ge 22) { Write-Host "Node.js $major (ok)"; return $true }
    if ($major -gt 0) { Write-Host "Node.js $major is too old: nextlevel needs 22 or newer." } else { Write-Host 'Node.js is not installed: nextlevel needs version 22 or newer.' }
    if ($OnWindows -and (Test-Cmd 'winget') -and (Ask 'Install Node.js LTS with winget now?')) {
      $null = Run-Here 'winget' @('install', '-e', '--id', 'OpenJS.NodeJS.LTS', '--accept-source-agreements', '--accept-package-agreements')
      Update-SessionPath
      if ((Get-NodeMajor) -ge 22) { return $true }
    }
    Stop-With "Install Node.js 22 or newer (PowerShell: winget install -e --id OpenJS.NodeJS.LTS), open a new PowerShell window. $Again"
    return $false
  }
  function Confirm-Git {
    if (Test-Cmd 'git') { return $true }
    Write-Host 'Git is not installed: nextlevel keeps itself up to date with it.'
    if ($OnWindows -and (Test-Cmd 'winget') -and (Ask 'Install Git with winget now?')) {
      $null = Run-Here 'winget' @('install', '-e', '--id', 'Git.Git', '--accept-source-agreements', '--accept-package-agreements')
      Update-SessionPath
      if (Test-Cmd 'git') { return $true }
    }
    Stop-With "Install Git (PowerShell: winget install -e --id Git.Git), open a new PowerShell window. $Again"
    return $false
  }
  # Changing the tool under a running hub or worker would mix old and new code.
  # Both sides are compared in their long form (Get-LongPath): a folder and a command line can name the same
  # place with short 8.3 names or without. A folder ends in \ so that tool.old-... isn't taken for tool.
  function Test-Running([string[]]$Folders) {
    if (-not $OnWindows) { return $false }
    $want = @($Folders | Where-Object { $_ } | ForEach-Object { Get-LongPath $_; $_ } | ForEach-Object { $_.Replace('/', '\').TrimEnd('\').ToLowerInvariant() + '\' } | Select-Object -Unique)
    try {
      $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop | Where-Object {
          $c = (Get-LongCommandLine ([string]$_.CommandLine)).Replace('/', '\').ToLowerInvariant()
          (@($want | Where-Object { $c.Contains($_) }).Count -gt 0) -or ($c -match 'node_modules[\\/]nextlevel[\\/]')
        })
    } catch { return $false }
    if ($procs.Count -eq 0) { return $false }
    Stop-With ('nextlevel is running on this PC ({0} process(es): a hub, a worker or the menu). Close those windows (a worker window closes by itself when it is done). {1}' -f $procs.Count, $Again)
    foreach ($p in $procs) { Write-Host ('  ' + $p.CommandLine) }
    return $true
  }

  function Copy-Tool {
    Write-Host "Getting nextlevel ($Repo) into $Dir"
    $ghReady = $false
    if (Test-Cmd 'gh') {
      & gh auth status > $null 2> $null
      $ghReady = ($LASTEXITCODE -eq 0)
    }
    if (-not $ghReady) {
      # Without the GitHub CLI: a public repository
      $ok = Invoke-NoPrompt { Run-Git @('-c', 'credential.helper=', 'clone', '--quiet', $RepoUrl, $Dir) }
      if ($ok) { return $true }
      Write-Host ''
      Write-Host "GitHub didn't hand out $Repo without a login: for a private repository, this PC needs the GitHub CLI, signed in to an account that can see it."
      if (-not (Test-Cmd 'gh')) {
        if ($OnWindows -and (Test-Cmd 'winget') -and (Ask 'Install the GitHub CLI with winget now?')) {
          $null = Run-Here 'winget' @('install', '-e', '--id', 'GitHub.cli', '--accept-source-agreements', '--accept-package-agreements')
          Update-SessionPath
        }
        if (-not (Test-Cmd 'gh')) {
          Stop-With "Install the GitHub CLI (PowerShell: winget install -e --id GitHub.cli), open a new PowerShell window and sign in there: gh auth login. $Again"
          return $false
        }
      }
      Write-Host 'Sign in to GitHub (it opens the browser: choose GitHub.com, HTTPS, and log in with the browser).'
      if (-not (Run-Here 'gh' @('auth', 'login'))) {
        Stop-With "Not signed in to GitHub. In PowerShell: gh auth login. $Again"
        return $false
      }
    }
    & gh repo clone $Repo $Dir | Out-Host
    if ($LASTEXITCODE -eq 0) { return $true }
    Stop-With "The GitHub CLI couldn't clone $Repo (it said why above). Is your GitHub account one that can see it? gh auth status shows who you are signed in as. $Again"
    return $false
  }

  # The newest release: an annotated tag vX.Y.Z (v0.1.0 or later) on main, fetched into nextlevel's own namespace
  # (refs/nextlevel/tags/), so a tag that moved on GitHub never makes the fetch fail. `nextlevel _install` checks it again
  # (its message, and that it never moved: ~/.nextlevel/releases.json) and puts it in a folder of its own.
  function Get-Release([string]$Only) {
    $lines = (Invoke-Git @('-C', $Dir, 'for-each-ref', '--sort=-v:refname', '--format=%(refname:strip=3) %(objecttype) %(*objectname)', 'refs/nextlevel/tags/')).Out -split "`n"
    foreach ($l in $lines) {
      $p = @($l.Trim() -split ' ')
      if ($p.Count -lt 3) { continue }
      if ($p[0] -notmatch '^v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$') { continue }
      if ($Only -and $p[0] -ne $Only) { continue }
      if ($p[1] -ne 'tag') { continue }
      if ([version]($p[0].Substring(1)) -lt [version]'0.1.0') { continue }
      if (-not (Invoke-Git @('-C', $Dir, 'merge-base', '--is-ancestor', $p[2], 'refs/remotes/origin/main')).Ok) { continue }
      return [pscustomobject]@{ Name = $p[0]; Commit = $p[2] }
    }
    return $null
  }

  # Bring the clone to the newest release (or the release NEXTLEVEL_REF names): its checkout runs `nextlevel _install`,
  # which puts that release in a folder of its own. A pinned install from before releases moves to it too: the pin was
  # for exactly that move. With no release published yet: NEXTLEVEL_REF, or else the default branch, as before (a clone
  # left on another branch moves to main; a pinned clone stays pinned).
  function Set-Version {
    $auth = @(Get-AuthArgs)
    $fetched = Invoke-NoPrompt { Run-Git (@('-C', $Dir) + $auth + @('fetch', '--quiet', '--no-tags', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/v*:refs/nextlevel/tags/v*')) }
    if (-not $fetched) {
      Stop-With "Couldn't download from $RepoUrl. If git said 'Repository not found' or asked for a login: sign in to GitHub (PowerShell: gh auth login). $Again"
      return $false
    }
    $changed = (Invoke-Git @('-C', $Dir, 'status', '--porcelain', '--untracked-files=no')).Out
    if ($changed) {
      Stop-With "Files in $Dir were changed by hand, so the installer leaves that folder as it is:"
      Write-Host $changed
      Write-Host "To put the changes aside (git stash pop brings them back), in PowerShell: git -C `"$Dir`" stash"
      Write-Host $Again
      return $false
    }
    $branch = (Invoke-Git @('-C', $Dir, 'symbolic-ref', '--short', '-q', 'HEAD')).Out
    $release = $null
    if ($Ref -match '^v\d+\.\d+\.\d+$') {
      $release = Get-Release $Ref
      if (-not $release) {
        Stop-With "There is no release $Ref in $Repo (NEXTLEVEL_REF): a release is an annotated tag on main, v0.1.0 or later."
        return $false
      }
      $env:NEXTLEVEL_RELEASE = $Ref
    } elseif (-not $Ref) {
      $release = Get-Release ''
    }
    if ($release) {
      if (-not (Run-Git @('-C', $Dir, 'switch', '--quiet', '--detach', $release.Commit))) {
        Stop-With "Couldn't check out nextlevel $($release.Name) in $Dir (git said why above). $Again"
        return $false
      }
      Write-Host "nextlevel $($release.Name) is the release to install."
      return $true
    }
    $target = $Ref
    if (-not $target) {
      if (-not $branch) {
        $at = (Invoke-Git @('-C', $Dir, 'describe', '--tags', '--always', 'HEAD')).Out
        Write-Host "nextlevel is pinned at $at, so it stays there until the first release is published (this installer then moves it there)."
        return $true
      }
      $target = (Invoke-Git @('-C', $Dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).Out -replace '^origin/', ''
      if (-not $target) { $target = 'main' }
    }
    if ((Invoke-Git @('-C', $Dir, 'rev-parse', '--verify', '--quiet', "refs/remotes/origin/$target")).Ok) {
      if ($branch -ne $target) {
        if ((Invoke-Git @('-C', $Dir, 'rev-parse', '--verify', '--quiet', "refs/heads/$target")).Ok) {
          $ok = Run-Git @('-C', $Dir, 'switch', '--quiet', $target)
        } else {
          $ok = Run-Git @('-C', $Dir, 'switch', '--quiet', '--track', "origin/$target")
        }
        if (-not $ok) {
          Stop-With "Couldn't switch $Dir to $target (git said why above). $Again"
          return $false
        }
        if ($branch) { Write-Host "Moved the tool from the branch $branch to $target (that branch is still there)." }
      }
      $null = Invoke-Git @('-C', $Dir, 'branch', '--quiet', '--set-upstream-to', "origin/$target")
      if (-not (Run-Git @('-C', $Dir, 'merge', '--ff-only', '--quiet', "origin/$target"))) {
        Stop-With "$target in $Dir has commits that GitHub doesn't, so it can't simply move forward. To see them: git -C `"$Dir`" log origin/$target..$target"
        return $false
      }
      return $true
    }
    if ((Invoke-Git @('-C', $Dir, 'rev-parse', '--verify', '--quiet', "$target^{commit}")).Ok) {
      if (-not (Run-Git @('-C', $Dir, 'switch', '--quiet', '--detach', $target))) {
        Stop-With "Couldn't check out $target (git said why above). $Again"
        return $false
      }
      Write-Host "nextlevel is pinned at $target (this installer moves it to the first release once one is published)."
      return $true
    }
    Stop-With "There is no branch or tag called $target in $Repo (NEXTLEVEL_REF)."
    return $false
  }

  # Where the tool goes: NEXTLEVEL_DIR, else where it was installed last time, else ~/.nextlevel/tool. An
  # install somewhere else ($Old) moves there.
  $Remembered = Get-RememberedDir
  $Old = ''
  if ($Remembered -and (Test-Clone $Remembered)) { $Old = Get-FullPath $Remembered }
  elseif (Test-Clone $DefaultDir) { $Old = Get-FullPath $DefaultDir }
  if ($env:NEXTLEVEL_DIR) { $Dir = Get-FullPath $env:NEXTLEVEL_DIR }
  elseif ($Old) { $Dir = $Old }
  else { $Dir = Get-FullPath $DefaultDir }
  $Chosen = [bool]$env:NEXTLEVEL_DIR
  $Moving = [bool]($Old -and -not (Test-SamePath $Old $Dir))
  Write-Host "nextlevel installer: the tool goes in $Dir"
  if ($OnWindows) {
    try {
      $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
      if ($me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host 'Note: this PowerShell runs as Administrator. nextlevel belongs in a normal window (not "Run as administrator"): files made from here can end up belonging to the administrator.' -ForegroundColor Yellow
      }
    } catch { }
  }
  if (-not (Confirm-Node)) { return }
  if (-not (Confirm-Git)) { return }
  if (Test-Running @($Dir, $Old, $DefaultDir, $Remembered, (Join-Path $Base 'versions'), $Bin)) { return }

  # A folder the owner named is theirs: nextlevel goes in only when it is new, empty or nextlevel already
  if ($Chosen -and (Test-Path -LiteralPath $Dir) -and -not (Test-Clone $Dir)) {
    if (@(Get-ChildItem -LiteralPath $Dir -Force -ErrorAction SilentlyContinue).Count -gt 0) {
      Stop-With "$Dir already has other files in it. nextlevel goes in a folder of its own: name a new one, for example $(Join-Path $Dir 'nextlevel'). $Again"
      return
    }
  }
  # Which repository the clone follows is settled first: a folder move (NEXTLEVEL_DIR) never leaves an install moved
  # but refused
  $Clone = if ($Moving -and -not (Test-Clone $Dir)) { $Old } elseif (Test-Clone $Dir) { $Dir } else { '' }
  if ($Clone -and -not (Confirm-Origin $Clone)) { return }
  $Copied = $false
  if ($Moving -and -not (Test-Clone $Dir)) {
    $how = Move-Tool $Old
    if ($how -eq 'stop') { return }
    $Copied = ($how -eq 'copy')
  } elseif ($Moving) {
    Write-Host "nextlevel is already in ${Dir}, so that one is used from now on, and $Old is not."
  }

  if (Test-Path -LiteralPath (Join-Path $Dir '.git')) {
    if (-not (Confirm-Origin $Dir)) { return }
    Write-Host 'Found nextlevel there: bringing it up to date.'
  } else {
    if ((Test-Path -LiteralPath $Dir) -and -not $Chosen) {
      $aside = "$Dir.old-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
      try { Move-Item -LiteralPath $Dir -Destination $aside -ErrorAction Stop } catch {
        Stop-With "$Dir is there but isn't a git clone, and it couldn't be moved aside ($($_.Exception.Message)). Close what uses it, or move it yourself. $Again"
        return
      }
      Write-Host "$Dir wasn't a git clone (an unzipped or copied folder?): moved it to $aside"
    }
    $null = New-Item -ItemType Directory -Force -Path $Base
    if (-not (Copy-Tool)) { return }
  }
  if (-not (Set-Version)) { return }

  & node ([IO.Path]::Combine($Dir, 'bin', 'nextlevel.mjs')) _install | Out-Host
  $env:NEXTLEVEL_RELEASE = $null
  if ($LASTEXITCODE -ne 0) {
    Stop-With "Making the nextlevel command failed (the lines above say why). $Again"
    return
  }
  if (-not (($env:PATH -split [regex]::Escape($Sep)) -contains $Bin)) { $env:PATH = $Bin + $Sep + $env:PATH }
  Write-Host ''
  & nextlevel version | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Stop-With 'The nextlevel command does not run in this window yet: open a new PowerShell window and type nextlevel version there.'
    return
  }
  Write-Host ''
  if ($Moving) {
    Write-Host "nextlevel now runs from $Dir; the nextlevel command and its updates use that folder." -ForegroundColor Green
    if ($Copied -or (Test-Path -LiteralPath $Old)) { Write-Host "The old folder $Old isn't used any more: delete it when you like." }
  }
  Write-Host 'nextlevel is installed. PowerShell windows that were open before this one do not know the nextlevel command yet: open a new one.' -ForegroundColor Green
  Write-Host 'Next, in PowerShell in your project folder: nextlevel init, then nextlevel doctor (the README has the details).'
  Write-Host 'nextlevel updates when you click Update on its dashboard''s Home (or nextlevel update); running this installer again repairs the install.'
}
