//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const (
	menuOwnerSecurityInformation = 0x00000001
	menuDACLInformation          = 0x00000004
	menuProtectedDACLInformation = 0x80000000
	menuDACLProtectedControl     = 0x1000
	menuSecurityObjectFile       = 1
	menuAccessAllowedACE         = 0
	menuInheritedACE             = 0x10
	menuTrusteeIsSID             = 0
	menuTrusteeIsUser            = 1
	menuFileAllAccess            = 0x001F01FF
	menuSetAccess                = 2
)

type menuACL struct {
	Revision byte
	Sbz1     byte
	AclSize  uint16
	AceCount uint16
	Sbz2     uint16
}

type menuACEHeader struct {
	AceType  byte
	AceFlags byte
	AceSize  uint16
}

type menuTrustee struct {
	MultipleTrusteeOperation uint32
	TrusteeForm              uint32
	TrusteeType              uint32
	Identifier               uintptr
}

type menuExplicitAccess struct {
	AccessPermissions uint32
	AccessMode        uint32
	Inheritance       uint32
	Trustee           menuTrustee
}

var (
	menuAdvapi32              = syscall.NewLazyDLL("advapi32.dll")
	menuGetNamedSecurityInfo  = menuAdvapi32.NewProc("GetNamedSecurityInfoW")
	menuGetSecurityDescriptor = menuAdvapi32.NewProc("GetSecurityDescriptorControl")
	menuGetACE                = menuAdvapi32.NewProc("GetAce")
)

func validMenuPrivateFile(path string, info os.FileInfo) bool {
	return validMenuWindowsPath(path, info)
}

func validMenuExecutable(path string, info os.FileInfo) bool {
	return info != nil && strings.EqualFold(filepath.Ext(path), ".exe") && validMenuWindowsPath(path, info)
}

func validMenuWindowsPath(path string, info os.FileInfo) bool {
	if info == nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	owner, dacl, err := menuPathSecurity(path)
	if err != nil || dacl == nil {
		return false
	}
	current, err := menuCurrentUserSID()
	return err == nil && owner == current && menuDACLIsPrivate(dacl, current)
}

func menuCurrentUserSID() (string, error) {
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return "", err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil || user == nil || user.User.Sid == nil {
		return "", errors.New("the current Windows user SID is unavailable")
	}
	return user.User.Sid.String()
}

func menuPathSecurity(path string) (string, *menuACL, error) {
	widePath, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "", nil, err
	}
	var owner *syscall.SID
	var dacl *menuACL
	var descriptor uintptr
	result, _, _ := menuGetNamedSecurityInfo.Call(
		uintptr(unsafe.Pointer(widePath)), menuSecurityObjectFile,
		menuOwnerSecurityInformation|menuDACLInformation,
		uintptr(unsafe.Pointer(&owner)), 0, uintptr(unsafe.Pointer(&dacl)), 0,
		uintptr(unsafe.Pointer(&descriptor)),
	)
	if result != 0 {
		return "", nil, syscall.Errno(result)
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	if owner == nil || dacl == nil {
		return "", nil, errors.New("the Windows file security descriptor is incomplete")
	}
	ownerString, err := owner.String()
	if err != nil {
		return "", nil, err
	}
	var control uint16
	var revision uint32
	ok, _, _ := menuGetSecurityDescriptor.Call(descriptor, uintptr(unsafe.Pointer(&control)), uintptr(unsafe.Pointer(&revision)))
	if ok == 0 || control&menuDACLProtectedControl == 0 {
		return "", nil, errors.New("the Windows file DACL is not protected")
	}
	return ownerString, dacl, nil
}

func menuDACLIsPrivate(dacl *menuACL, owner string) bool {
	if dacl == nil || dacl.AceCount != 1 || dacl.AclSize < uint16(unsafe.Sizeof(menuACL{})) {
		return false
	}
	var ace uintptr
	ok, _, _ := menuGetACE.Call(uintptr(unsafe.Pointer(dacl)), 0, uintptr(unsafe.Pointer(&ace)))
	if ok == 0 || ace == 0 {
		return false
	}
	header := (*menuACEHeader)(unsafe.Pointer(ace))
	if header.AceType != menuAccessAllowedACE || header.AceFlags&menuInheritedACE != 0 || header.AceSize < 12 {
		return false
	}
	mask := *(*uint32)(unsafe.Pointer(ace + 4))
	if mask != menuFileAllAccess {
		return false
	}
	sid := (*syscall.SID)(unsafe.Pointer(ace + 8))
	identity, err := sid.String()
	return err == nil && identity == owner
}
