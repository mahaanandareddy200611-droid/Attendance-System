const test = require("node:test");
const assert = require("node:assert/strict");
const { updateSectionLocation } = require("../src/modules/academic/AcademicValidator");

test("accepts valid classroom coordinates", () => {
    const result = updateSectionLocation.validate({
        latitude: 10,
        longitude: 20
    });
    assert.equal(result.error, undefined);
});

test("rejects latitude outside the earth coordinate range", () => {
    const result = updateSectionLocation.validate({
        latitude: 91,
        longitude: 20
    });
    assert.ok(result.error);
});

test("rejects longitude outside the earth coordinate range", () => {
    const result = updateSectionLocation.validate({
        latitude: 10,
        longitude: 181
    });
    assert.ok(result.error);
});

test("requires both coordinates and rejects additional fields", () => {
    assert.ok(updateSectionLocation.validate({ latitude: 10 }).error);
    assert.ok(updateSectionLocation.validate({
        latitude: 10,
        longitude: 20,
        status: "ACTIVE"
    }).error);
});