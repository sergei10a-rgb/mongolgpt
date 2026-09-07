#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>

static void fail(void) {
  fputs("MongolGPT workspace isolation failed.\n", stderr);
  _exit(125);
}

static unsigned int identity(const char *text) {
  char *end;
  errno = 0;
  unsigned long value = strtoul(text, &end, 10);
  if (errno || !*text || *end || value < 10000 || value > 60000) fail();
  return (unsigned int)value;
}

/* Outstanding asynchronous kernel writes can outlive a userspace freezer.
 * Force synchronous filesystem APIs before any untrusted code runs. */
static void restrict_async_io(void) {
#if defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported workspace architecture
#endif
#define DENY(nr) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, nr, 0, 1), \
                 BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS)
  struct sock_filter filters[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    /* x32 uses the x86_64 audit architecture with different syscall numbers. */
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
    DENY(__NR_io_uring_setup),
    DENY(__NR_io_uring_enter),
    DENY(__NR_io_uring_register),
    DENY(__NR_io_setup),
    DENY(__NR_io_submit),
    DENY(__NR_io_cancel),
    DENY(__NR_io_destroy),
    DENY(__NR_io_getevents),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {
    .len = sizeof(filters) / sizeof(filters[0]),
    .filter = filters,
  };
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0) fail();
}

/* fd 3 is an already-validated, root-owned cgroup.procs opened by the
 * supervisor. Join BEFORE dropping privileges or executing user code. */
int main(int argc, char **argv) {
  if (argc < 5 || getuid() != 0 || geteuid() != 0 || argv[3][0] != '/' || argv[4][0] != '/') fail();
  unsigned int uid = identity(argv[1]);
  unsigned int gid = identity(argv[2]);
  char pid[32];
  int size = snprintf(pid, sizeof(pid), "%ld", (long)getpid());
  if (size <= 0 || write(3, pid, (size_t)size) != size || close(3) != 0) fail();
  struct rlimit core = { .rlim_cur = 0, .rlim_max = 0 };
  if (setrlimit(RLIMIT_CORE, &core) != 0) fail();
  for (int cap = 0; cap <= CAP_LAST_CAP; cap++) {
    if (prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) != 0 && errno != EINVAL) fail();
  }
  if (setgroups(0, NULL) != 0 || setresgid(gid, gid, gid) != 0 || setresuid(uid, uid, uid) != 0) fail();
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail();
  restrict_async_io();
  /* Resolve the tenant-controlled cwd only after losing root privileges. */
  if (chdir(argv[3]) != 0) fail();
  execv(argv[4], argv + 4);
  fail();
}
