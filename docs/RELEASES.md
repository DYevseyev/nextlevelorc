# nextlevel releases

The installed tool updates only to a release: an annotated tag `vX.Y.Z` on main, made once the manual checks of that
commit passed (CLAUDE.md, "Releases"; `docs/design/safe-updates.md`). The tag's message is what the tool reads and Home
shows; this file is the same notes, for people, newest first, each added by a pull request after its tag.

The first public release is `v0.2.0`.

## v0.2.0

The first public release, tagged on 25 October 2026 on commit `56ed3234792da2fa0242d0f77754c032a83a8afb` (the merge of
#1). Tag object `01fef89cd906833310da0e508c52dd64f779a6a8`.

Fixes:
- Safety: the dashboard's link no longer carries its key. It carries a one-time code, good once and for a minute, so your address bar, browser history and logs never hold a key that could approve a held change or a push.
- The doctor's Held changes row names a held push and its commit, instead of an empty "a change on disk". (#1)
- nextlevel fix works only on an issue in the repository nextlevel was installed from.

New:
- nextlevel is open source (Apache-2.0), published at github.com/DYevseyev/nextlevelorc.
- An install can move to another repository: run the new one's install command after $env:NEXTLEVEL_MOVE_FROM = "owner/name". Its versions, pinned projects and settings stay, and field reports keep going where they went.
- The Team page's GitHub checks card says where a project's checks run and how many minutes they used in the last 30 days, and a guard card for a workflow says where its jobs run.

After install:
- A dashboard tab that was open before the update stops working: open the dashboard again (START.cmd -> d).
