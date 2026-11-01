import path from "node:path";

// Parse shell words without evaluating substitutions or expanding environment values.
function tokenize(source) {
  const tokens = [];
  let word = "",
    raw = "",
    quote = null,
    started = false,
    substitutions = [];
  const flush = () => {
    if (started)
      tokens.push({
        value: word,
        assignment: /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw),
        substitutions,
      });
    word = "";
    raw = "";
    started = false;
    substitutions = [];
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\" && quote !== "'") {
      if (source[i + 1] === "\n") {
        i++;
        continue;
      }
      raw += char + (source[i + 1] ?? "");
      word += source[++i] ?? "";
      started = true;
      continue;
    }
    if (
      !quote &&
      char === "<" &&
      source[i + 1] === "<" &&
      source[i + 2] !== "<"
    ) {
      flush();
      const delimiter = /^<<(-)?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(
        source.slice(i),
      );
      if (delimiter) {
        const start = source.indexOf("\n", i);
        if (start >= 0) {
          let end = start + 1;
          while (end < source.length) {
            const next = source.indexOf("\n", end);
            const line = source.slice(end, next < 0 ? source.length : next);
            if (
              (delimiter[1] ? line.replace(/^\t+/, "") : line) === delimiter[3]
            ) {
              const body = source.slice(start + 1, end);
              if (!delimiter[2]) {
                tokens.push({
                  value: "",
                  assignment: false,
                  substitutions: [
                    ...body.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g),
                  ].map((match) => match[1] ?? match[2]),
                });
              }
              source =
                source.slice(0, start + 1) +
                source.slice(next < 0 ? source.length : next + 1);
              break;
            }
            if (next < 0) break;
            end = next + 1;
          }
        }
        i += delimiter[0].length - 1;
        continue;
      }
    }
    if (!quote && /[<>]/.test(char) && source[i + 1] !== "(") {
      if (/^\d+$/.test(raw)) {
        word = "";
        raw = "";
        started = false;
      }
      flush();
      const operator =
        /^(?:<<<|>>|<>|>&|<&|>\||>|<)/.exec(source.slice(i))?.[0] ?? char;
      tokens.push({ redirect: true, substitutions: [] });
      i += operator.length - 1;
      continue;
    }
    if (
      quote !== "'" &&
      (char === "`" || (char === "$" && source[i + 1] === "("))
    ) {
      const begin = i + (char === "`" ? 1 : 2);
      let end = begin,
        nesting = 1;
      for (; end < source.length; end++) {
        if (source[end] === "\\") {
          end++;
          continue;
        }
        if (char === "`" && source[end] === "`") break;
        if (char === "$") {
          if (source[end] === "(") nesting++;
          if (source[end] === ")") {
            nesting--;
            if (nesting === 0) break;
          }
        }
      }
      substitutions.push(source.slice(begin, end));
      raw += source.slice(i, end + 1);
      word += source.slice(i, end + 1);
      started = true;
      i = end;
      continue;
    }
    if (quote) {
      raw += char;
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      raw += char;
      started = true;
      continue;
    }
    if (char === "#" && !started) {
      while (i < source.length && source[i] !== "\n") i++;
    }
    if (char === "\n" || source[i] === "\n" || /[;&|()]/.test(char)) {
      flush();
      tokens.push({ separator: true });
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    raw += char;
    word += char;
    started = true;
  }
  flush();
  return tokens;
}

function isExpensive(words) {
  const executable = path.basename(words[0] ?? "");
  const args = words.slice(1);
  if (["pnpm", "npm", "yarn", "bun", "npx"].includes(executable)) {
    // Strip package-manager global options before interpreting a command.
    let i = 0;
    while (args[i]?.startsWith("-")) {
      const option = args[i++];
      if (
        ["--filter", "-F", "--dir", "-C", "--prefix", "--cwd"].includes(option)
      )
        i++;
    }
    if (["run", "run-script", "exec", "dlx", "x"].includes(args[i])) i++;
    while (args[i]?.startsWith("-")) {
      const option = args[i++];
      if (
        ["--filter", "-F", "--dir", "-C", "--prefix", "--cwd"].includes(option)
      )
        i++;
    }
    const command = args[i];
    if (command === "e2e") return true;
    if (command === "test:integration")
      return !hasSpecFilter(args.slice(i + 1));
    return isExpensive(args.slice(i));
  }
  if (["timeout", "time", "nohup", "nice", "caffeinate"].includes(executable)) {
    let i = 0;
    while (args[i]?.startsWith("-")) {
      const option = args[i++];
      if (
        [
          "-n",
          "--adjustment",
          "-s",
          "--signal",
          "-k",
          "--kill-after",
          "-t",
          "-o",
          "--output",
        ].includes(option)
      )
        i++;
    }
    if (executable === "timeout") i++;
    return isExpensive(args.slice(i));
  }
  if (
    executable === "node" &&
    ["playwright", "vitest"].includes(path.basename(args[0] ?? ""))
  )
    return isExpensive(args);
  if (executable === "vitest") {
    return (
      args.some((arg) =>
        /(?:^|[/=])vitest\.integration\.config\.[cm]?[jt]s$/.test(arg),
      ) && !hasSpecFilter(args)
    );
  }
  if (executable === "playwright") return args.includes("test");
  if (
    executable === "dotenv" ||
    (executable === "node" && /(?:^|\/)require-env\.mjs$/.test(args[0] ?? ""))
  ) {
    const separator = args.indexOf("--");
    return separator >= 0 && isExpensive(args.slice(separator + 1));
  }
  return false;
}

function hasSpecFilter(args) {
  const valueOptions = new Set([
    "-c",
    "--config",
    "-t",
    "--testNamePattern",
    "--exclude",
    "--reporter",
    "--outputFile",
    "--dir",
    "--root",
    "--project",
    "--workspace",
    "--pool",
    "--environment",
    "--testTimeout",
    "--hookTimeout",
    "--maxWorkers",
    "--minWorkers",
    "--retry",
    "--shard",
    "--bail",
    "--api",
    "--inspect",
    "--inspectBrk",
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (valueOptions.has(arg)) i++;
      continue;
    }
    if (
      !/[*?\[\]{}$]/.test(arg) &&
      /(?:^|\/)tests\/integration\/[^\s]+\.spec\.[cm]?[jt]sx?$/.test(arg)
    )
      return true;
  }
  return false;
}

export function needsTestConsent(source, inheritedConsent = false, depth = 0) {
  if (depth > 10) return true;
  let command = [];
  const inspect = () => {
    let consent = inheritedConsent;
    const argumentsOnly = [];
    for (let j = 0; j < command.length; j++) {
      if (command[j].redirect) {
        j++;
        continue;
      }
      argumentsOnly.push(command[j]);
    }
    let i = 0;
    while (argumentsOnly[i]?.assignment) {
      if (argumentsOnly[i].value.startsWith("RUN_FULL_TESTS="))
        consent = argumentsOnly[i].value === "RUN_FULL_TESTS=1";
      i++;
    }
    let words = argumentsOnly.slice(i).map((token) => token.value);
    for (;;) {
      if (["command", "exec"].includes(words[0])) {
        words.shift();
        if (words[0] === "--") words.shift();
        continue;
      }
      if (path.basename(words[0] ?? "") !== "env") break;
      {
        words.shift();
        while (words.length) {
          const value = words[0];
          if (value === "--") {
            words.shift();
            break;
          }
          if (value === "-i" || value === "--ignore-environment") {
            consent = false;
            words.shift();
            continue;
          }
          if (value === "-u" || value === "--unset") {
            words.shift();
            if (words.shift() === "RUN_FULL_TESTS") consent = false;
            continue;
          }
          if (value.startsWith("--unset=")) {
            if (value === "--unset=RUN_FULL_TESTS") consent = false;
            words.shift();
            continue;
          }
          if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) break;
          if (value.startsWith("RUN_FULL_TESTS="))
            consent = value === "RUN_FULL_TESTS=1";
          words.shift();
        }
      }
    }
    if (["sh", "bash", "zsh"].includes(path.basename(words[0] ?? ""))) {
      const index = words.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word));
      if (
        index >= 0 &&
        words[index + 1] &&
        needsTestConsent(words[index + 1], consent, depth + 1)
      )
        return true;
    }
    for (const token of command) {
      for (const substitution of token.substitutions) {
        if (needsTestConsent(substitution, inheritedConsent, depth + 1))
          return true;
      }
    }
    return !consent && isExpensive(words);
  };
  for (const token of tokenize(source)) {
    if (token.separator) {
      if (inspect()) return true;
      command = [];
    } else command.push(token);
  }
  return inspect();
}
