import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOffer, describeOffer } from "../src/lib/compute.ts";

test("a share of the machine becomes absolute usable numbers", () => {
  const o = parseOffer({ share: 0.25, machine: { cores: 64, ram_gb: 256, gpu: { name: "RTX 5090", vram_gb: 32 }, disk_free_gb: 900 }, mathlib_cache: true }, 2);
  assert.equal(o.usable.cores, 16); assert.equal(o.usable.ram_gb, 64); assert.equal(o.usable.vram_gb, 8); assert.equal(o.usable.cpu_hours, 32);
  assert.match(describeOffer(o), /^25% of 64 cores \/ 256 GB \/ RTX 5090 32 GB: 16 cores, 64 GB, 8 GB VRAM, 32 CPU h per assignment, Mathlib cache allowed$/);
});
test("a laptop at the same share is a small offer", () => {
  const o = parseOffer({ share: 0.25, machine: { cores: 8, ram_gb: 16, gpu: null, disk_free_gb: 40 } }, 1);
  assert.equal(o.usable.cores, 2); assert.equal(o.usable.ram_gb, 4); assert.equal(o.usable.vram_gb, 0); assert.equal(o.usable.cpu_hours, 2);
});
test("share 0 or nothing measured is no offer; legacy fixed shape still parses", () => {
  assert.equal(parseOffer({ share: 0, machine: { cores: 8, ram_gb: 16 } }, 2), null);
  assert.equal(parseOffer(null, 2), null);
  assert.equal(parseOffer({ machine: {} }, 2), null);
  const legacy = parseOffer({ cpu_hours: 4, ram_gb: 16, mathlib_cache: false }, 2);
  assert.equal(legacy.share, 1); assert.equal(legacy.usable.cpu_hours, 4); assert.equal(legacy.usable.ram_gb, 16);
  assert.equal(describeOffer(null), "not offered");
});
test("a cpu_hours cap next to the share is the person's own cap and is the number shown", () => {
  // A reviewer agent registered { cpu_hours: 1, share, machine } and was told 10 CPU h in the brief and 0 in the registration line (Sep 10).
  const o = parseOffer({ cpu_hours: 1, share: 0.25, machine: { cores: 20, ram_gb: 128, gpu: null, disk_free_gb: 100 } }, 2);
  assert.equal(o.usable.cores, 5); assert.equal(o.usable.ram_gb, 32); assert.equal(o.usable.cpu_hours, 1); assert.equal(o.cap_hours, 1);
  assert.match(describeOffer(o), /5 cores, 32 GB, 1 CPU h per assignment \(their own cap\)$/);
  // A cap above what the share yields changes nothing.
  const loose = parseOffer({ cpu_hours: 100, share: 0.25, machine: { cores: 20, ram_gb: 128 } }, 2);
  assert.equal(loose.usable.cpu_hours, 10); assert.doesNotMatch(describeOffer(loose), /their own cap/);
});
