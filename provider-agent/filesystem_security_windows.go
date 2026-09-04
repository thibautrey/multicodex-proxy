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
	windowsSecurityDescriptorOwnerInformation = 0x00000001
	windowsSecurityDescriptorDACLInformation  = 0x00000004
	windowsProtectedDACLInformation           = 0x80000000
	windowsDACLProtectedControl               = 0x1000
	windowsSecurityObjectFile                 = 1
	windowsAccessAllowedACE                   = 0
	windowsInheritedACE                       = 0x10
	windowsTrusteeIsSID                       = 0
	windowsTrusteeIsUser                      = 1
	windowsFileAllAccess                      = 0x001F01FF
	windowsSetAccess                          = 2
)

type windowsACL struct {
	Revision byte
	Sbz1     byte
	AclSize  uint16
	AceCount uint16
	Sbz2     uint16
}

type windowsACEHeader struct {
	AceType  byte
	AceFlags byte
	AceSize  uint16
}

type windowsTrustee struct {
	MultipleTrusteeOperation uint32
	TrusteeForm              uint32
	TrusteeType              uint32
	Identifier               uintptr
}

type windowsExplicitAccess struct {
	AccessPermissions uint32
	AccessMode        uint32
	Inheritance       uint32
	Trustee           windowsTrustee
}

var (
	windowsAdvapi32              = syscall.NewLazyDLL("advapi32.dll")
	windowsGetNamedSecurityInfo  = windowsAdvapi32.NewProc("GetNamedSecurityInfoW")
	windowsSetNamedSecurityInfo  = windowsAdvapi32.NewProc("SetNamedSecurityInfoW")
	windowsGetSecurityDescriptor = windowsAdvapi32.NewProc("GetSecurityDescriptorControl")
	windowsGetSecurityOwner      = windowsAdvapi32.NewProc("GetSecurityDescriptorOwner")
	windowsGetSecurityDACL       = windowsAdvapi32.NewProc("GetSecurityDescriptorDacl")
	windowsSetEntriesInACL       = windowsAdvapi32.NewProc("SetEntriesInAclW")
	windowsGetACE                = windowsAdvapi32.NewProc("GetAce")
)

func providerPrivateFile(path string, info os.FileInfo) bool {
	return windowsPrivatePath(path, info, false)
}

func providerPrivateDirectory(path string, info os.FileInfo) bool {
	return windowsPrivatePath(path, info, true)
}

func providerExecutableFile(path string, info os.FileInfo) bool {
	return info != nil && strings.EqualFold(filepath.Ext(path), ".exe") && windowsPrivatePath(path, info, false)
}

func providerManagedRuntimeFile(path string, info os.FileInfo) bool {
	return windowsPrivatePath(path, info, false)
}

func providerOwnedByCurrentUser(path string, info os.FileInfo) bool {
	if info == nil || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	owner, _, err := windowsPathSecurity(path)
	if err != nil {
		return false
	}
	current, err := windowsCurrentUserSID()
	return err == nil && owner == current
}

func secureProviderPrivateFile(path string) error {
	return windowsSetPrivatePathACL(path)
}

func secureProviderPrivateDirectory(path string) error {
	return windowsSetPrivatePathACL(path)
}

func secureProviderExecutableFile(path string) error {
	return windowsSetPrivatePathACL(path)
}

func secureProviderManagedRuntimeFile(path string) error {
	return windowsSetPrivatePathACL(path)
}

func windowsPrivatePath(path string, info os.FileInfo, directory bool) bool {
	if info == nil || info.Mode()&os.ModeSymlink != 0 || (directory && !info.IsDir()) || (!directory && !info.Mode().IsRegular()) {
		return false
	}
	owner, dacl, err := windowsPathSecurity(path)
	if err != nil {
		return false
	}
	current, err := windowsCurrentUserSID()
	if err != nil || owner != current || dacl == nil {
		return false
	}
	return windowsDACLIsPrivate(dacl, current)
}

func windowsCurrentUserSID() (string, error) {
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

func windowsPathSecurity(path string) (string, *windowsACL, error) {
	widePath, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "", nil, err
	}
	var owner *syscall.SID
	var dacl *windowsACL
	var descriptor uintptr
	result, _, _ := windowsGetNamedSecurityInfo.Call(
		uintptr(unsafe.Pointer(widePath)),
		windowsSecurityObjectFile,
		windowsSecurityDescriptorOwnerInformation|windowsSecurityDescriptorDACLInformation,
		uintptr(unsafe.Pointer(&owner)), 0, uintptr(unsafe.Pointer(&dacl)), 0,
		uintptr(unsafe.Pointer(&descriptor)),
	)
	if result != 0 {
		return "", nil, syscall.Errno(result)
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	if owner == nil {
		return "", nil, errors.New("the Windows file owner is unavailable")
	}
	ownerString, err := owner.String()
	if err != nil {
		return "", nil, err
	}
	if dacl == nil {
		return ownerString, nil, nil
	}
	var control uint16
	var controlRevision uint32
	ok, _, callErr := windowsGetSecurityDescriptor.Call(
		descriptor, uintptr(unsafe.Pointer(&control)), uintptr(unsafe.Pointer(&controlRevision)),
	)
	if ok == 0 || callErr != syscall.Errno(0) || control&uint16(windowsDACLProtectedControl) == 0 {
		return "", nil, errors.New("the Windows file DACL is not protected")
	}
	return ownerString, dacl, nil
}

func windowsDACLIsPrivate(dacl *windowsACL, owner string) bool {
	if dacl == nil || dacl.AceCount != 1 || dacl.AclSize < uint16(unsafe.Sizeof(windowsACL{})) {
		return false
	}
	var ace uintptr
	ok, _, _ := windowsGetACE.Call(uintptr(unsafe.Pointer(dacl)), 0, uintptr(unsafe.Pointer(&ace)))
	if ok == 0 || ace == 0 {
		return false
	}
	header := (*windowsACEHeader)(unsafe.Pointer(ace))
	if header.AceType != windowsAccessAllowedACE || header.AceFlags&windowsInheritedACE != 0 || header.AceSize < 12 {
		return false
	}
	mask := *(*uint32)(unsafe.Pointer(ace + 4))
	if mask != windowsFileAllAccess {
		return false
	}
	sid := (*syscall.SID)(unsafe.Pointer(ace + 8))
	identity, err := sid.String()
	return err == nil && identity == owner
}

func windowsSetPrivatePathACL(path string) error {
	widePath, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil || user == nil || user.User.Sid == nil {
		return errors.New("the current Windows user SID is unavailable")
	}
	entry := windowsExplicitAccess{
		AccessPermissions: windowsFileAllAccess,
		AccessMode:        windowsSetAccess,
		Trustee: windowsTrustee{
			TrusteeForm: windowsTrusteeIsSID,
			TrusteeType: windowsTrusteeIsUser,
			Identifier:  uintptr(unsafe.Pointer(user.User.Sid)),
		},
	}
	var dacl *windowsACL
	result, _, _ := windowsSetEntriesInACL.Call(
		1, uintptr(unsafe.Pointer(&entry)), 0, uintptr(unsafe.Pointer(&dacl)),
	)
	if result != 0 || dacl == nil {
		return syscall.Errno(result)
	}
	defer syscall.LocalFree(syscall.Handle(uintptr(unsafe.Pointer(dacl))))
	result, _, _ = windowsSetNamedSecurityInfo.Call(
		uintptr(unsafe.Pointer(widePath)),
		windowsSecurityObjectFile,
		windowsSecurityDescriptorOwnerInformation|windowsSecurityDescriptorDACLInformation|windowsProtectedDACLInformation,
		uintptr(unsafe.Pointer(user.User.Sid)), 0, uintptr(unsafe.Pointer(dacl)), 0,
	)
	if result != 0 {
		return syscall.Errno(result)
	}
	return nil
}
