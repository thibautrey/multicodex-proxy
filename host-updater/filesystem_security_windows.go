//go:build windows

package main

import (
	"errors"
	"os"
	"syscall"
	"unsafe"
)

const (
	updaterOwnerSecurityInformation = 0x00000001
	updaterDACLInformation          = 0x00000004
	updaterProtectedDACLInformation = 0x80000000
	updaterDACLProtectedControl     = 0x1000
	updaterSecurityObjectFile       = 1
	updaterAccessAllowedACE         = 0
	updaterInheritedACE             = 0x10
	updaterTrusteeIsSID             = 0
	updaterTrusteeIsUser            = 1
	updaterFileAllAccess            = 0x001F01FF
	updaterSetAccess                = 2
	moveFileReplaceExisting         = 0x00000001
	moveFileWriteThrough            = 0x00000008
)

type updaterACL struct {
	Revision byte
	Sbz1     byte
	AclSize  uint16
	AceCount uint16
	Sbz2     uint16
}

type updaterACEHeader struct {
	AceType  byte
	AceFlags byte
	AceSize  uint16
}

type updaterTrustee struct {
	MultipleTrusteeOperation uint32
	TrusteeForm              uint32
	TrusteeType              uint32
	Identifier               uintptr
}

type updaterExplicitAccess struct {
	AccessPermissions uint32
	AccessMode        uint32
	Inheritance       uint32
	Trustee           updaterTrustee
}

var (
	updaterAdvapi32              = syscall.NewLazyDLL("advapi32.dll")
	updaterGetNamedSecurityInfo  = updaterAdvapi32.NewProc("GetNamedSecurityInfoW")
	updaterSetNamedSecurityInfo  = updaterAdvapi32.NewProc("SetNamedSecurityInfoW")
	updaterGetSecurityDescriptor = updaterAdvapi32.NewProc("GetSecurityDescriptorControl")
	updaterGetACE                = updaterAdvapi32.NewProc("GetAce")
	updaterSetEntriesInACL       = updaterAdvapi32.NewProc("SetEntriesInAclW")
	updaterKernel32              = syscall.NewLazyDLL("kernel32.dll")
	updaterMoveFileEx            = updaterKernel32.NewProc("MoveFileExW")
)

func updaterPrivateFile(path string, info os.FileInfo) bool {
	return updaterPrivatePath(path, info, false)
}

func updaterPrivateDirectory(path string, info os.FileInfo) bool {
	return updaterPrivatePath(path, info, true)
}

func updaterPrivatePath(path string, info os.FileInfo, directory bool) bool {
	if info == nil || info.Mode()&os.ModeSymlink != 0 || (directory && !info.IsDir()) || (!directory && !info.Mode().IsRegular()) {
		return false
	}
	owner, dacl, err := updaterPathSecurity(path)
	if err != nil || dacl == nil {
		return false
	}
	current, err := updaterCurrentUserSID()
	return err == nil && owner == current && updaterDACLIsPrivate(dacl, current)
}

func secureUpdaterPrivateFile(path string) error      { return updaterSetPrivatePathACL(path) }
func secureUpdaterPrivateDirectory(path string) error { return updaterSetPrivatePathACL(path) }

func replaceUpdaterFile(source, destination string) error {
	sourcePath, err := syscall.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	destinationPath, err := syscall.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	result, _, callErr := updaterMoveFileEx.Call(
		uintptr(unsafe.Pointer(sourcePath)), uintptr(unsafe.Pointer(destinationPath)),
		moveFileReplaceExisting|moveFileWriteThrough,
	)
	if result == 0 {
		if callErr != syscall.Errno(0) {
			return callErr
		}
		return errors.New("Windows could not atomically replace the update file")
	}
	return nil
}

func updaterCurrentUserSID() (string, error) {
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

func updaterPathSecurity(path string) (string, *updaterACL, error) {
	widePath, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "", nil, err
	}
	var owner *syscall.SID
	var dacl *updaterACL
	var descriptor uintptr
	result, _, _ := updaterGetNamedSecurityInfo.Call(
		uintptr(unsafe.Pointer(widePath)), updaterSecurityObjectFile,
		updaterOwnerSecurityInformation|updaterDACLInformation,
		uintptr(unsafe.Pointer(&owner)), 0, uintptr(unsafe.Pointer(&dacl)), 0,
		uintptr(unsafe.Pointer(&descriptor)),
	)
	if result != 0 {
		return "", nil, syscall.Errno(result)
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	if owner == nil || dacl == nil {
		return "", nil, errors.New("the Windows update path security descriptor is incomplete")
	}
	ownerString, err := owner.String()
	if err != nil {
		return "", nil, err
	}
	var control uint16
	var revision uint32
	ok, _, _ := updaterGetSecurityDescriptor.Call(descriptor, uintptr(unsafe.Pointer(&control)), uintptr(unsafe.Pointer(&revision)))
	if ok == 0 || control&updaterDACLProtectedControl == 0 {
		return "", nil, errors.New("the Windows update path DACL is not protected")
	}
	return ownerString, dacl, nil
}

func updaterDACLIsPrivate(dacl *updaterACL, owner string) bool {
	if dacl == nil || dacl.AceCount != 1 || dacl.AclSize < uint16(unsafe.Sizeof(updaterACL{})) {
		return false
	}
	var ace uintptr
	ok, _, _ := updaterGetACE.Call(uintptr(unsafe.Pointer(dacl)), 0, uintptr(unsafe.Pointer(&ace)))
	if ok == 0 || ace == 0 {
		return false
	}
	header := (*updaterACEHeader)(unsafe.Pointer(ace))
	if header.AceType != updaterAccessAllowedACE || header.AceFlags&updaterInheritedACE != 0 || header.AceSize < 12 {
		return false
	}
	mask := *(*uint32)(unsafe.Pointer(ace + 4))
	if mask != updaterFileAllAccess {
		return false
	}
	sid := (*syscall.SID)(unsafe.Pointer(ace + 8))
	identity, err := sid.String()
	return err == nil && identity == owner
}

func updaterSetPrivatePathACL(path string) error {
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
	entry := updaterExplicitAccess{
		AccessPermissions: updaterFileAllAccess,
		AccessMode:        updaterSetAccess,
		Trustee: updaterTrustee{
			TrusteeForm: updaterTrusteeIsSID,
			TrusteeType: updaterTrusteeIsUser,
			Identifier:  uintptr(unsafe.Pointer(user.User.Sid)),
		},
	}
	var dacl *updaterACL
	result, _, _ := updaterSetEntriesInACL.Call(1, uintptr(unsafe.Pointer(&entry)), 0, uintptr(unsafe.Pointer(&dacl)))
	if result != 0 || dacl == nil {
		return syscall.Errno(result)
	}
	defer syscall.LocalFree(syscall.Handle(uintptr(unsafe.Pointer(dacl))))
	result, _, _ = updaterSetNamedSecurityInfo.Call(
		uintptr(unsafe.Pointer(widePath)), updaterSecurityObjectFile,
		updaterOwnerSecurityInformation|updaterDACLInformation|updaterProtectedDACLInformation,
		uintptr(unsafe.Pointer(user.User.Sid)), 0, uintptr(unsafe.Pointer(dacl)), 0,
	)
	if result != 0 {
		return syscall.Errno(result)
	}
	return nil
}
