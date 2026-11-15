import { describe, expect, test } from "bun:test";
import { parseQuery } from "./search-query";

describe("kind operators", () => {
  test("English words pick the source kind with is: and type:", () => {
    expect(parseQuery("plano is:message").kinds).toEqual(["message"]);
    expect(parseQuery("plano type:files").kinds).toEqual(["file"]);
    expect(parseQuery("is:page is:issues is:debate is:row is:event").kinds).toEqual([
      "wiki",
      "issue",
      "debate",
      "db_row",
      "event",
    ]);
  });

  test("pt-BR words pick the same kinds, with or without accents and in any case", () => {
    expect(parseQuery("plano is:mensagem").kinds).toEqual(["message"]);
    expect(
      parseQuery("is:mensagens type:Página is:arquivos is:tarefa type:tópico is:linha is:eventos").kinds,
    ).toEqual(["message", "wiki", "file", "issue", "debate", "db_row", "event"]);
    expect(parseQuery("is:TAREFAS is:tarefa is:issue").kinds).toEqual(["issue"]);
  });

  test("an unknown kind word is a warning, and state facets still work", () => {
    const q = parseQuery("plano is:folder type:poll is:pinned");
    expect(q.kinds).toEqual([]);
    expect(q.is).toEqual(["pinned"]);
    expect(q.warnings).toEqual(["is:folder", "type:poll"]);
    expect(q.terms).toEqual(["plano"]);
  });
});

describe("kind words from the query", () => {
  test("names inherited by every object are unknown words, not kinds", () => {
    for (const word of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      for (const op of ["is", "type"]) {
        const q = parseQuery(`deploy ${op}:${word}`);
        expect(q.kinds).toEqual([]);
        expect(q.is).toEqual([]);
        expect(q.warnings).toEqual([`${op}:${word}`]);
        expect(q.terms).toEqual(["deploy"]);
      }
    }
  });
});
