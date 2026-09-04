//go:build windows

package runtimebenchmark

import (
	"errors"
	"os"
	"syscall"
	"unsafe"
)

const (
	runtimeBenchmarkMoveFileReplaceExisting = 0x00000001
	runtimeBenchmarkMoveFileWriteThrough    = 0x00000008
)

var runtimeBenchmarkKernel32 = syscall.NewLazyDLL("kernel32.dll")
var runtimeBenchmarkMoveFileEx = runtimeBenchmarkKernel32.NewProc("MoveFileExW")

func replaceRuntimeBenchmarkFile(source, destination string) error {
	sourcePath, err := syscall.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	destinationPath, err := syscall.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	result, _, callErr := runtimeBenchmarkMoveFileEx.Call(
		uintptr(unsafe.Pointer(sourcePath)), uintptr(unsafe.Pointer(destinationPath)),
		runtimeBenchmarkMoveFileReplaceExisting|runtimeBenchmarkMoveFileWriteThrough,
	)
	if result != 0 {
		return nil
	}
	if callErr != syscall.Errno(0) {
		return callErr
	}
	return errors.New("Windows could not atomically replace the benchmark store")
}

func secureRuntimeBenchmarkPrivateFile(path string) error {
	return runtimeBenchmarkSetPrivatePathACL(path)
}

func secureRuntimeBenchmarkPrivateDirectory(path string) error {
	return runtimeBenchmarkSetPrivatePathACL(path)
}

func runtimeBenchmarkPrivateFile(path string, info os.FileInfo) bool {
	return runtimeBenchmarkPrivatePath(path, info, false)
}

func runtimeBenchmarkPrivateDirectory(path string, info os.FileInfo) bool {
	return runtimeBenchmarkPrivatePath(path, info, true)
}

func runtimeBenchmarkOwnedByCurrentUser(path string, info os.FileInfo) bool {
	if info == nil || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	owner, _, err := runtimeBenchmarkPathSecurity(path)
	if err != nil {
		return false
	}
	current, err := runtimeBenchmarkCurrentUserSID()
	return err == nil && owner == current
}

func runtimeBenchmarkPrivatePath(path string, info os.FileInfo, directory bool) bool {
	if info == nil || info.Mode()&os.ModeSymlink != 0 || (directory && !info.IsDir()) || (!directory && !info.Mode().IsRegular()) {
		return false
	}
	owner, dacl, err := runtimeBenchmarkPathSecurity(path)
	if err != nil {
		return false
	}
	current, err := runtimeBenchmarkCurrentUserSID()
	if err != nil || owner != current || dacl == nil {
		return false
	}
	return runtimeBenchmarkDACLIsPrivate(dacl, current)
}

const (
	runtimeBenchmarkSecurityDescriptorOwnerInformation = 0x00000001
	runtimeBenchmarkSecurityDescriptorDACLInformation  = 0x00000004
	runtimeBenchmarkProtectedDACLInformation           = 0x80000000
	runtimeBenchmarkDACLProtectedControl               = 0x1000
	runtimeBenchmarkSecurityObjectFile                 = 1
	runtimeBenchmarkAccessAllowedACE                   = 0
	runtimeBenchmarkInheritedACE                       = 0x10
	runtimeBenchmarkTrusteeIsSID                       = 0
	runtimeBenchmarkTrusteeIsUser                      = 1
	runtimeBenchmarkFileAllAccess                      = 0x001F01FF
	runtimeBenchmarkSetAccess                          = 2
)

type runtimeBenchmarkACL struct {
	Revision byte
	Sbz1     byte
	AclSize  uint16
	AceCount uint16
	Sbz2     uint16
}

type runtimeBenchmarkACEHeader struct {
	AceType  byte
	AceFlags byte
	AceSize  uint16
}

type runtimeBenchmarkTrustee struct {
	MultipleTrusteeOperation uint32
	TrusteeForm              uint32
	TrusteeType              uint32
	Identifier               uintptr
}

type runtimeBenchmarkExplicitAccess struct {
	AccessPermissions uint32
	AccessMode        uint32
	Inheritance       uint32
	Trustee           runtimeBenchmarkTrustee
}

var (
	runtimeBenchmarkAdvapi32              = syscall.NewLazyDLL("advapi32.dll")
	runtimeBenchmarkGetNamedSecurityInfo  = runtimeBenchmarkAdvapi32.NewProc("GetNamedSecurityInfoW")
	runtimeBenchmarkSetNamedSecurityInfo  = runtimeBenchmarkAdvapi32.NewProc("SetNamedSecurityInfoW")
	runtimeBenchmarkGetSecurityDescriptor = runtimeBenchmarkAdvapi32.NewProc("GetSecurityDescriptorControl")
	runtimeBenchmarkSetEntriesInACL       = runtimeBenchmarkAdvapi32.NewProc("SetEntriesInAclW")
	runtimeBenchmarkGetACE                = runtimeBenchmarkAdvapi32.NewProc("GetAce")
)

func runtimeBenchmarkCurrentUserSID() (string, error) {
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

func runtimeBenchmarkPathSecurity(path string) (string, *runtimeBenchmarkACL, error) {
	widePath, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "", nil, err
	}
	var owner *syscall.SID
	var dacl *runtimeBenchmarkACL
	var descriptor uintptr
	result, _, _ := runtimeBenchmarkGetNamedSecurityInfo.Call(
		uintptr(unsafe.Pointer(widePath)), runtimeBenchmarkSecurityObjectFile,
		runtimeBenchmarkSecurityDescriptorOwnerInformation|runtimeBenchmarkSecurityDescriptorDACLInformation,
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
	ok, _, _ := runtimeBenchmarkGetSecurityDescriptor.Call(
		descriptor, uintptr(unsafe.Pointer(&control)), uintptr(unsafe.Pointer(&controlRevision)),
	)
	if ok == 0 || control&uint16(runtimeBenchmarkDACLProtectedControl) == 0 {
		return "", nil, errors.New("the Windows file DACL is not protected")
	}
	return ownerString, dacl, nil
}

func runtimeBenchmarkDACLIsPrivate(dacl *runtimeBenchmarkACL, owner string) bool {
	if dacl == nil || dacl.AceCount != 1 || dacl.AclSize < uint16(unsafe.Sizeof(runtimeBenchmarkACL{})) {
		return false
	}
	var ace uintptr
	ok, _, _ := runtimeBenchmarkGetACE.Call(uintptr(unsafe.Pointer(dacl)), 0, uintptr(unsafe.Pointer(&ace)))
	if ok == 0 || ace == 0 {
		return false
	}
	header := (*runtimeBenchmarkACEHeader)(unsafe.Pointer(ace))
	if header.AceType != runtimeBenchmarkAccessAllowedACE || header.AceFlags&runtimeBenchmarkInheritedACE != 0 || header.AceSize < 12 {
		return false
	}
	mask := *(*uint32)(unsafe.Pointer(ace + 4))
	if mask != runtimeBenchmarkFileAllAccess {
		return false
	}
	sid := (*syscall.SID)(unsafe.Pointer(ace + 8))
	identity, err := sid.String()
	return err == nil && identity == owner
}

func runtimeBenchmarkSetPrivatePathACL(path string) error {
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
	entry := runtimeBenchmarkExplicitAccess{
		AccessPermissions: runtimeBenchmarkFileAllAccess,
		AccessMode:        runtimeBenchmarkSetAccess,
		Trustee: runtimeBenchmarkTrustee{
			TrusteeForm: runtimeBenchmarkTrusteeIsSID,
			TrusteeType: runtimeBenchmarkTrusteeIsUser,
			Identifier:  uintptr(unsafe.Pointer(user.User.Sid)),
		},
	}
	var dacl *runtimeBenchmarkACL
	result, _, _ := runtimeBenchmarkSetEntriesInACL.Call(1, uintptr(unsafe.Pointer(&entry)), 0, uintptr(unsafe.Pointer(&dacl)))
	if result != 0 {
		return syscall.Errno(result)
	}
	if dacl == nil {
		return errors.New("the Windows private ACL could not be created")
	}
	defer syscall.LocalFree(syscall.Handle(uintptr(unsafe.Pointer(dacl))))
	result, _, _ = runtimeBenchmarkSetNamedSecurityInfo.Call(
		uintptr(unsafe.Pointer(widePath)), runtimeBenchmarkSecurityObjectFile,
		runtimeBenchmarkSecurityDescriptorOwnerInformation|runtimeBenchmarkSecurityDescriptorDACLInformation|runtimeBenchmarkProtectedDACLInformation,
		uintptr(unsafe.Pointer(user.User.Sid)), 0, uintptr(unsafe.Pointer(dacl)), 0,
	)
	if result != 0 {
		return syscall.Errno(result)
	}
	return nil
}
