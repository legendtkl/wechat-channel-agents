declare module "qrcode-terminal" {
  const qrcode: {
    generate(text: string, opts?: { small?: boolean }): void;
  };
  export default qrcode;
}
