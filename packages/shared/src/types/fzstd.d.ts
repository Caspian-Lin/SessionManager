declare module 'fzstd' {
  export function decompress(input: Uint8Array): Uint8Array;
  export function compress(input: Uint8Array, level?: number): Uint8Array;
}
