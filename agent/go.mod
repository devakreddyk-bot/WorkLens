// The agent is a separate Go module from the rest of the monorepo: it is the only Go in the
// repository, it cross-compiles for Windows, and keeping its dependency set isolated means a
// backend or dashboard change can never affect what ends up in the binary that runs on an
// employee's laptop.
module github.com/worklens/worklens/agent

// 1.23 is the floor. The toolchain in use may be newer; nothing here depends on a later
// language feature, and pinning the floor low keeps the build reproducible on an LTS image.
go 1.25.0

require (
	fyne.io/systray v1.12.2
	github.com/kbinani/screenshot v0.0.0-20250624051815-089614a94018
)

require (
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	modernc.org/libc v1.74.4 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.11.0 // indirect
)

require (
	github.com/gen2brain/shm v0.1.0 // indirect
	github.com/godbus/dbus/v5 v5.1.0 // indirect
	github.com/jezek/xgb v1.1.1 // indirect
	github.com/lxn/win v0.0.0-20210218163916-a377121e959e // indirect
	golang.org/x/sys v0.47.0
	modernc.org/sqlite v1.56.0
)
