//go:build !linux || !cgo

package main

import (
	"fmt"
	"os"
)

var menuApplicationVersion = "dev"

func main() {
	if len(os.Args) == 2 && (os.Args[1] == "version" || os.Args[1] == "--version" || os.Args[1] == "-version") {
		fmt.Fprintln(os.Stdout, menuApplicationVersion)
		return
	}
	fmt.Fprintln(os.Stderr, "multivibe-host-menu: the Linux graphical menu requires GTK 3 and cgo")
	os.Exit(1)
}
