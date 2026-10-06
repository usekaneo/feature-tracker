/** Local SMTP sink for integration checks. Nothing is forwarded externally. */
export function startFakeSmtp(opts: { hostname?: string; port?: number } = {}) {
  const messages: { to: string; content: string }[] = [];
  type State = { buffer: string; receiving: boolean; to: string; content: string };
  const server = Bun.listen<State>({
    hostname: opts.hostname ?? "127.0.0.1", port: opts.port ?? 0,
    socket: {
      open(socket) {
        socket.data = { buffer: "", receiving: false, to: "", content: "" };
        socket.write("220 localhost ESMTP test sink\r\n");
      },
      data(socket, bytes) {
        const state = socket.data;
        state.buffer += Buffer.from(bytes).toString();
        for (;;) {
          const end = state.buffer.indexOf("\r\n");
          if (end < 0) break;
          const line = state.buffer.slice(0, end);
          state.buffer = state.buffer.slice(end + 2);
          if (state.receiving) {
            if (line === ".") {
              messages.push({ to: state.to, content: state.content });
              state.receiving = false; state.content = "";
              socket.write("250 Message accepted\r\n");
            } else state.content += `${line.replace(/^\.\./, ".")}\r\n`;
          } else if (/^(EHLO|HELO) /i.test(line)) socket.write("250-localhost\r\n250 8BITMIME\r\n");
          else if (/^MAIL FROM:/i.test(line)) { state.to = ""; socket.write("250 OK\r\n"); }
          else if (/^RCPT TO:/i.test(line)) { state.to = line.slice(8).trim().replace(/^<|>$/g, ""); socket.write("250 OK\r\n"); }
          else if (line === "DATA") { state.receiving = true; socket.write("354 End with a dot\r\n"); }
          else if (line === "QUIT") { socket.end("221 Bye\r\n"); }
          else if (line === "RSET" || line === "NOOP") socket.write("250 OK\r\n");
          else socket.write("502 Unsupported test command\r\n");
        }
      },
      error() {},
    },
  });
  return { port: server.port, messages, stop: () => server.stop(true) };
}
