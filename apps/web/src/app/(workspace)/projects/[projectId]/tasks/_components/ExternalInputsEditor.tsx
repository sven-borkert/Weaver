"use client";

import { useState } from "react";
import type { ScopeRequest } from "@weaver/core/assistant/scopeSchema";
import type {
  AvailableExternalTool,
  ExternalInput,
} from "@weaver/core/externalMcp/types";
import { MAX_EXTERNAL_INPUTS } from "@weaver/core/externalMcp/limits";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  buildLiteralInput,
  eligibleTaskTools,
  literalArgumentsText,
} from "~/lib/tasks/externalInputs";
import { api } from "~/trpc/react";

export function ExternalInputsEditor({
  scope,
  outputProjectId,
  value,
  onChange,
  disabled,
}: {
  scope: ScopeRequest;
  outputProjectId: string;
  value: ExternalInput[];
  onChange: (value: ExternalInput[]) => void;
  disabled?: boolean;
}) {
  const [rows, setRows] = useState({
    value,
    ids: value.map((_, index) => index),
    nextId: value.length,
  });
  if (rows.value !== value) {
    let nextId = rows.nextId;
    const ids = value.map((input) => {
      const previous = rows.value.indexOf(input);
      return previous < 0 ? nextId++ : rows.ids[previous]!;
    });
    setRows({ value, ids, nextId });
  }
  const publish = (
    next: ExternalInput[],
    ids = rows.ids,
    nextId = rows.nextId,
  ) => {
    setRows({ value: next, ids, nextId });
    onChange(next);
  };
  const options = { staleTime: 0, refetchOnMount: "always" as const };
  const source = api.externalMcp.availability.useQuery({ scope }, options);
  const output = api.externalMcp.availability.useQuery(
    { scope: { kind: "project", projectId: outputProjectId } },
    options,
  );
  const ready =
    !source.isFetching && !output.isFetching && !source.error && !output.error;
  const tools = ready
    ? eligibleTaskTools(source.data?.tools ?? [], output.data?.tools ?? [])
    : [];
  const connections = source.data?.connections ?? [];
  const update = (index: number, next: ExternalInput) =>
    publish(value.map((item, i) => (i === index ? next : item)));
  const move = (index: number, delta: number) => {
    const next = [...value];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    const ids = [...rows.ids];
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    publish(next, ids);
  };
  return (
    <fieldset
      disabled={disabled}
      className="border-line flex flex-col gap-3 rounded-md border p-3"
    >
      <legend className="px-1 text-[13px] font-medium">
        External inputs (optional)
      </legend>
      <p className="text-text-3 text-[12px]">
        Up to five required inputs, fetched in order before each report. Only
        read tools you enabled can run unattended.
      </p>
      {!ready ? (
        <p role="status" className="text-text-3 text-[12px]">
          {source.isFetching || output.isFetching
            ? "Checking external input availability…"
            : "External inputs are unavailable. You can still save a task without external inputs."}{" "}
          {source.error || output.error ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void source.refetch();
                void output.refetch();
              }}
            >
              Retry availability
            </Button>
          ) : null}
        </p>
      ) : !tools.length ? (
        <p className="text-text-3 text-[12px]">
          No eligible read tools. Enable read tools under Account › MCP
          connections.
        </p>
      ) : null}
      {value.map((input, index) => (
        <div
          key={rows.ids[index]}
          className="border-line flex flex-col gap-2 rounded border p-3"
        >
          <Input
            aria-label={`Input ${index + 1} name`}
            maxLength={120}
            required
            value={input.name}
            onChange={(event) =>
              update(index, { ...input, name: event.target.value })
            }
          />
          <label className="text-[12px]">
            Tool
            <select
              className="bg-surface border-line mt-1 w-full rounded border p-2"
              aria-label={`Input ${index + 1} tool`}
              value={input.toolId}
              onChange={(event) =>
                update(index, { ...input, toolId: event.target.value })
              }
            >
              {!tools.some((tool) => tool.id === input.toolId) ? (
                <option value={input.toolId}>
                  Unavailable tool ({input.toolId})
                </option>
              ) : null}
              {tools.map((tool) => (
                <option key={tool.id} value={tool.id}>
                  {connections.find(
                    (connection) => connection.id === tool.connectionId,
                  )?.name ?? "Connection"}{" "}
                  · {tool.name}
                </option>
              ))}
            </select>
          </label>
          {!tools.some((tool) => tool.id === input.toolId) ? (
            <p role="alert" className="text-danger text-[12px]">
              {ready
                ? "This saved input is no longer eligible. Choose an available tool to repair it, or remove it. It has not been removed automatically."
                : "This saved input is retained while availability is checked. Retry, choose a replacement, or remove it."}
            </p>
          ) : null}
          <InputArguments
            input={input}
            index={index}
            tool={tools.find((tool) => tool.id === input.toolId)}
            onChange={(next) => update(index, next)}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              Move input {index + 1} up
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={index === value.length - 1}
              onClick={() => move(index, 1)}
            >
              Move input {index + 1} down
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                publish(
                  value.filter((_, i) => i !== index),
                  rows.ids.filter((_, i) => i !== index),
                )
              }
            >
              Remove input {index + 1}
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!tools.length || value.length >= MAX_EXTERNAL_INPUTS}
        onClick={() => {
          const tool = tools[0];
          if (!tool || value.length >= MAX_EXTERNAL_INPUTS) return;
          let number = value.length + 1;
          while (
            value.some(
              (input) => input.name.toLowerCase() === `input ${number}`,
            )
          )
            number++;
          publish(
            [
              ...value,
              { name: `Input ${number}`, toolId: tool.id, arguments: {} },
            ],
            [...rows.ids, rows.nextId],
            rows.nextId + 1,
          );
        }}
      >
        Add external input
      </Button>
    </fieldset>
  );
}

function InputArguments({
  input,
  index,
  tool,
  onChange,
}: {
  input: ExternalInput;
  index: number;
  tool?: AvailableExternalTool;
  onChange: (input: ExternalInput) => void;
}) {
  const [draft, setDraft] = useState({
    bindings: input.arguments,
    text: literalArgumentsText(input),
    error: "",
  });
  const [bindingKey, setBindingKey] = useState("");
  if (draft.bindings !== input.arguments)
    setDraft({
      bindings: input.arguments,
      text: literalArgumentsText(input),
      error: "",
    });
  return (
    <>
      <label className="text-[12px]">
        Literal arguments (JSON object)
        <Textarea
          ref={(element) => element?.setCustomValidity(draft.error)}
          aria-label={`Input ${index + 1} JSON arguments`}
          rows={4}
          value={draft.text}
          aria-invalid={!!draft.error}
          onChange={(event) => {
            const text = event.target.value;
            try {
              const next = buildLiteralInput(input.name, input.toolId, text);
              for (const [key, binding] of Object.entries(input.arguments))
                if (binding.kind !== "literal") next.arguments[key] = binding;
              event.target.setCustomValidity("");
              setDraft({ bindings: next.arguments, text, error: "" });
              onChange(next);
            } catch {
              const error =
                'Enter a valid JSON object, for example {"hours":24}.';
              event.target.setCustomValidity(error);
              setDraft({ bindings: input.arguments, text, error });
            }
          }}
        />
      </label>
      {draft.error ? (
        <p role="alert" className="text-danger text-[12px]">
          {draft.error}
        </p>
      ) : null}
      <p className="text-text-3 text-[12px]">
        Example: {`{"hours":24,"filters":["open"]}`}. Strings are literal text.
        The tool validates arguments against its schema when saved.
      </p>
      {tool ? (
        <details>
          <summary className="text-[12px]">
            Argument schema · {tool.name}
          </summary>
          <p className="text-text-3 text-[12px]">{tool.description}</p>
          <pre className="bg-subtle overflow-auto p-2 text-[11px] whitespace-pre-wrap">
            {JSON.stringify(tool.inputSchema, null, 2)}
          </pre>
        </details>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={`Input ${index + 1} period property`}
          placeholder="Top-level property name"
          value={bindingKey}
          onChange={(event) => setBindingKey(event.target.value)}
        />
        {(["period_start", "period_end"] as const).map((kind) => (
          <Button
            key={kind}
            type="button"
            size="sm"
            variant="outline"
            disabled={!bindingKey.trim() || !!draft.error}
            onClick={() => {
              onChange({
                ...input,
                arguments: {
                  ...input.arguments,
                  [bindingKey.trim()]: { kind },
                },
              });
              setBindingKey("");
            }}
          >
            Bind {kind}
          </Button>
        ))}
      </div>
      <p className="text-text-3 text-[12px]">
        Period bindings explicitly replace a property with the report period’s
        start or end timestamp.
      </p>
      {Object.entries(input.arguments)
        .filter(([, binding]) => binding.kind !== "literal")
        .map(([key, binding]) => (
          <div key={key} className="flex items-center gap-2 text-[12px]">
            <span>
              {key}: {binding.kind}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!!draft.error}
              onClick={() => {
                const argumentsCopy = { ...input.arguments };
                delete argumentsCopy[key];
                onChange({ ...input, arguments: argumentsCopy });
              }}
            >
              Remove binding {key}
            </Button>
          </div>
        ))}
    </>
  );
}

export function ExternalInputsList({ value }: { value: ExternalInput[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[15px] font-semibold">External inputs</h2>
      {value.length ? (
        <ol className="list-decimal space-y-2 pl-5">
          {value.map((input, index) => (
            <li key={index} className="text-[13px]">
              <span className="font-medium">{input.name}</span>
              <span className="text-text-3"> · Tool {input.toolId}</span>
              <p className="text-text-3 text-[12px]">
                {Object.entries(input.arguments)
                  .map(
                    ([key, binding]) =>
                      `${key}: ${binding.kind === "literal" ? "literal value" : binding.kind}`,
                  )
                  .join(" · ") || "No arguments"}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-text-3 text-[13px]">No external inputs.</p>
      )}
    </section>
  );
}
