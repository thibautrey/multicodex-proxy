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
	hostOwnerSecurityInformation = 0x00000001
	hostDACLInformation          = 0x00000004
	hostDACLProtectedInformation = 0x80000000
	hostDACLProtectedControl     = 0x1000
	hostSecurityObjectFile       = 1
	hostAccessAllowedACE         = 0
	hostInheritedACE             = 0x10
	hostTrusteeIsSID             = 0
	hostTrusteeIsUser            = 1
	hostFileAllAccess            = 0x001F01FF
	hostSetAccess                = 2
)

type hostACL struct {
	Revision byte
	Sbz1     byte
	AclSize  uint16
	AceCount uint16
	Sbz2     uint16
}

type hostACEHeader struct {
	AceType  byte
	AceFlags byte
	AceSize  uint16
}

type hostTrustee struct {
	MultipleTrusteeOperation uint32
	TrusteeForm              uint32
	TrusteeType              uint32
	Identifier               uintptr
}

type hostExplicitAccess struct {
	AccessPermissions uint32
	AccessMode        uint32
	Inheritance       uint32
	Trustee           hostTrustee
}

var (
	hostAdvapi32              = syscall.NewLazyDLL("advapi32.dll")
	hostGetNamedSecurityInfo  = hostAdvapi32.NewProc("GetNamedSecurityInfoW")
	hostSetNamedSecurityInfo  = hostAdvapi32.NewProc("SetNamedSecurityInfoW")
	hostGetSecurityDescriptor = hostAdvapi32.NewProc("GetSecurityDescriptorControl")
	hostGetACE                = hostAdvapi32.NewProc("GetAce")
	hostSetEntriesInACL       = hostAdvapi32.NewProc("SetEntriesInAclW")
)

func hostPrivateFile(path string, info os.FileInfo) bool { return hostPrivatePath(path, info, false) }

func hostPrivateDirectory(path string, info os.FileInfo) bool {
	return hostPrivatePath(path, info, true)
}

func hostExecutableFile(path string, info os.FileInfo) bool {
	return info != nil && strings.EqualFold(filepath.Ext(path), ".exe") && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0
}

func secureHostPrivateFile(path string) error      { return hostSetPrivatePathACL(path) }
func secureHostPrivateDirectory(path string) error { return hostSetPrivatePathACL(path) }

func hostPrivatePath(path string, info os.FileInfo, directory bool) bool {
	if info == nil || info.Mode()&os.ModeSymlink != 0 || (directory && !info.IsDir()) || (!directory && !info.Mode().IsRegular()) {
		return false
	}
	owner, dacl, err := hostPathSecurity(path)
	if err != nil || dacl == nil {
		return false
	}
	current, err := hostCurrentUserSID()
	return err == nil && owner == current && hostDACLIsPrivate(dacl, current)
}

func hostCurrentUserSID() (string, error) {
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

func hostPathSecurity(path string) (string, *hostACL, error) {
	widePath, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "", nil, err
	}
	var owner *syscall.SID
	var dacl *hostACL
	var descriptor uintptr
	result, _, _ := hostGetNamedSecurityInfo.Call(
		uintptr(unsafe.Pointer(widePath)), hostSecurityObjectFile,
		hostOwnerSecurityInformation|hostDACLInformation,
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
	ok, _, _ := hostGetSecurityDescriptor.Call(descriptor, uintptr(unsafe.Pointer(&control)), uintptr(unsafe.Pointer(&revision)))
	if ok == 0 || control&hostDACLProtectedControl == 0 {
		return "", nil, errors.New("the Windows file DACL is not protected")
	}
	return ownerString, dacl, nil
}

func hostDACLIsPrivate(dacl *hostACL, owner string) bool {
	if dacl == nil || dacl.AceCount != 1 || dacl.AclSize < uint16(unsafe.Sizeof(hostACL{})) {
		return false
	}
	var ace uintptr
	ok, _, _ := hostGetACE.Call(uintptr(unsafe.Pointer(dacl)), 0, uintptr(unsafe.Pointer(&ace)))
	if ok == 0 || ace == 0 {
		return false
	}
	header := (*hostACEHeader)(unsafe.Pointer(ace))
	if header.AceType != hostAccessAllowedACE || header.AceFlags&hostInheritedACE != 0 || header.AceSize < 12 {
		return false
	}
	mask := *(*uint32)(unsafe.Pointer(ace + 4))
	if mask != hostFileAllAccess {
		return false
	}
	sid := (*syscall.SID)(unsafe.Pointer(ace + 8))
	identity, err := sid.String()
	return err == nil && identity == owner
}

func hostSetPrivatePathACL(path string) error {
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
	entry := hostExplicitAccess{
		AccessPermissions: hostFileAllAccess,
		AccessMode:        hostSetAccess,
		Trustee: hostTrustee{
			TrusteeForm: hostTrusteeIsSID,
			TrusteeType: hostTrusteeIsUser,
			Identifier:  uintptr(unsafe.Pointer(user.User.Sid)),
		},
	}
	var dacl *hostACL
	result, _, _ := hostSetEntriesInACL.Call(1, uintptr(unsafe.Pointer(&entry)), 0, uintptr(unsafe.Pointer(&dacl)))
	if result != 0 || dacl == nil {
		return syscall.Errno(result)
	}
	defer syscall.LocalFree(syscall.Handle(uintptr(unsafe.Pointer(dacl))))
	result, _, _ = hostSetNamedSecurityInfo.Call(
		uintptr(unsafe.Pointer(widePath)), hostSecurityObjectFile,
		hostOwnerSecurityInformation|hostDACLInformation|hostDACLProtectedInformation,
		uintptr(unsafe.Pointer(user.User.Sid)), 0, uintptr(unsafe.Pointer(dacl)), 0,
	)
	if result != 0 {
		return syscall.Errno(result)
	}
	return nil
}
