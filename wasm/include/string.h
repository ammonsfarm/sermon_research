/* The three functions minimp3 uses; Zig's compiler-rt provides them for freestanding WebAssembly. */
typedef __SIZE_TYPE__ size_t;
void *memcpy(void *dest, const void *src, size_t n);
void *memmove(void *dest, const void *src, size_t n);
void *memset(void *dest, int c, size_t n);
