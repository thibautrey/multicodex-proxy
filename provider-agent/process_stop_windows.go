//go:build windows

package main

func requestManagedOllamaStop(process managedOllamaProcess) error {
	// Windows does not provide POSIX SIGTERM semantics through os.Process.
	// Terminating the supervised child is the only supported graceful boundary;
	// Ollama is restarted by the controller when policy still authorizes it.
	return process.Kill()
}
