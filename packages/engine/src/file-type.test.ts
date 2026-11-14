import { expect, test } from "bun:test";
import { isSafeInline, sniffType } from "./file-type";

const b = (...xs: (number | string)[]) =>
  new Uint8Array(xs.flatMap((x) => (typeof x === "string" ? [...new TextEncoder().encode(x)] : [x])));

test("UTF-8 at the sniff limit keeps complete characters and tolerates only an incomplete tail", () => {
  for (const tail of ["éxxx", "€xx", "😀x"])
    expect(sniffType(b("x".repeat(4091) + tail), "text.md")).toBe("text/markdown");
  expect(sniffType(b(`${"x".repeat(4095)}😀`), "text.md")).toBe("text/markdown");
  expect(sniffType(b("x".repeat(4095), 0xff), "text.md")).toBeNull();
});

test("signatures of the formats the Drive shows", () => {
  expect(sniffType(b(0x89, "PNG\r\n", 0x1a, "\n", 0, 0), "x")).toBe("image/png");
  expect(sniffType(b(0xff, 0xd8, 0xff, 0xe0), "x")).toBe("image/jpeg");
  expect(sniffType(b("GIF89a"), "x")).toBe("image/gif");
  expect(sniffType(b("RIFF", 0, 0, 0, 0, "WEBPVP8 "), "x")).toBe("image/webp");
  expect(sniffType(b("RIFF", 0, 0, 0, 0, "WAVEfmt "), "x")).toBe("audio/wav");
  expect(sniffType(b(0, 0, 0, 0x20, "ftypisom"), "x")).toBe("video/mp4");
  expect(sniffType(b(0, 0, 0, 0x20, "ftypavif"), "x")).toBe("image/avif");
  expect(sniffType(b(0x1a, 0x45, 0xdf, 0xa3, "....webm"), "x")).toBe("video/webm");
  expect(sniffType(b("ID3", 4, 0), "x")).toBe("audio/mpeg");
  expect(sniffType(b("OggS", 0), "x")).toBe("audio/ogg");
  expect(sniffType(b("%PDF-1.7\n"), "x")).toBe("application/pdf");
  expect(sniffType(b("PK", 3, 4, 20), "a.docx")).toContain("wordprocessingml");
  expect(sniffType(b("PK", 3, 4, 20), "a.zip")).toBe("application/zip");
  expect(sniffType(b(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), "a.xls")).toBe(
    "application/vnd.ms-excel",
  );
  expect(sniffType(b("# Título\n\ntexto"), "a.md")).toBe("text/markdown");
  expect(sniffType(b("a,b\n1,2"), "a.csv")).toBe("text/csv");
  expect(sniffType(b("print('oi')"), "a.py")).toBe("text/plain");
  expect(sniffType(b(0, 1, 2, 3, 0xfe), "x.bin")).toBeNull();
});

test("attack: HTML or SVG with an image name and type stay HTML and SVG (and are not safe inline)", () => {
  for (const [body, type] of [
    ["<!DOCTYPE html><script>fetch('/api')</script>", "text/html"],
    ["  <html><body onload=x()>", "text/html"],
    ["﻿<script>alert(1)</script>", "text/html"],
    ["<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", "image/svg+xml"],
    ["<?xml version='1.0'?><svg><script>alert(1)</script></svg>", "image/svg+xml"],
  ] as const) {
    const t = sniffType(b(body), "foto.png");
    expect(t).toBe(type);
    expect(isSafeInline(t ?? "")).toBe(false);
  }
  expect(isSafeInline("image/png")).toBe(true);
  expect(isSafeInline("application/pdf")).toBe(true);
});
