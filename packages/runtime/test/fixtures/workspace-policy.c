#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(void) {
  errno = 0;
  long ring = syscall(SYS_io_uring_setup, 0, NULL);
  int ring_error = errno;
  errno = 0;
  long aio = syscall(SYS_io_setup, 0, NULL);
  int aio_error = errno;
  errno = 0;
  int root = setuid(0);
  int root_error = errno;
  printf("{\"uid\":%u,\"ringDenied\":%s,\"aioDenied\":%s,\"rootDenied\":%s}\n",
    getuid(), ring == -1 && ring_error == ENOSYS ? "true" : "false",
    aio == -1 && aio_error == ENOSYS ? "true" : "false",
    root == -1 && root_error == EPERM ? "true" : "false");
  return 0;
}
