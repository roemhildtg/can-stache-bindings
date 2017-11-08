var QUnit = require('steal-qunit');

var stache = require('can-stache');
var SimpleMap = require("can-simple-map");
var mutateDeps = require("can-reflect-mutate-dependencies");
var MockComponent = require("../mock-component-simple-map");
require('can-stache-bindings');

QUnit.module('bindings mutation dependencies', {
	beforeEach: function() {
		this.fixture = document.getElementById("qunit-fixture");
	},
	afterEach: function() {
		document.body.removeChild(this.fixture);
	}
});

// input <-> attribute observation -> scopeKeyData
// parent: scope, child: viewModelOrAttribute
QUnit.test("parent to child mutation dependencies", function(assert) {
	var template = stache('<input value:from="age">');

	var map = new SimpleMap();
	var frag = template(map);

	var ta = this.fixture;
	ta.appendChild(frag);

	var input = ta.getElementsByTagName("input")[0];
	var inputDependencies = mutateDeps.getKeyDependencies(input, "value");
	assert.ok(
		inputDependencies.mutatedValueDependencies.size,
		"the input should have mutation dependencies"
	);

	// tests: input <-> attribute observation
	var attributeObservation = Array.from(inputDependencies.mutatedValueDependencies)[0];
	var attributeObservationDependencies = mutateDeps.getValueDependencies(
		attributeObservation
	);
	assert.ok(
		attributeObservationDependencies.keyDependencies.get(input).has("value"),
		"the input's 'value' attribute should be a dependency of the attribute observation"
	);
	assert.ok(
		attributeObservationDependencies.mutatedValueDependencies.size,
		"the attribute observation should have mutation dependencies"
	);

	// tests: scopeKeyData <- attribute internal observation
	var scopeKeyDataDependencies = mutateDeps.getValueDependencies(
		Array.from(attributeObservationDependencies.mutatedValueDependencies)[0]
	);
	assert.ok(
		!scopeKeyDataDependencies.mutatedValueDependencies,
		"the attribute observation should NOT be a dependency of scopeKeyData"
	);
});

// input <-> attribute observation <-> scopeKeyData
QUnit.test("attribute cross binding mutation dependencies", function(assert) {
	var template = stache('<input value:bind="age">');

	var scope = new SimpleMap({ age: 8 });
	var frag = template(scope);

	var ta = this.fixture;
	ta.appendChild(frag);

	var input = ta.getElementsByTagName("input")[0];
	var inputDependencies = mutateDeps.getKeyDependencies(input, "value");
	assert.ok(
		inputDependencies.mutatedValueDependencies.size,
		"the input should have mutation dependencies"
	);

	// tests: input <-> attribute observation
	var attributeObservation = Array.from(inputDependencies.mutatedValueDependencies)[0];
	var attributeObservationDependencies = mutateDeps.getValueDependencies(
		attributeObservation
	);
	assert.ok(
		attributeObservationDependencies(input).has("value"),
		"the input's 'value' attribute should be a dependency of the attribute observation"
	);
	assert.ok(
		attributeObservationDependencies.mutatedValueDependencies.size,
		"the attribute observation should have mutation dependencies"
	);

	// tests: scopeKeyData <-> attribute internal observation
	var scopeKeyDataDependencies = mutateDeps.getValueDependencies(
		Array.from(attributeObservationDependencies.mutatedValueDependencies)[0]
	);
	assert.ok(
		scopeKeyDataDependencies.mutatedValueDependencies.has(attributeObservation),
		"the attribute observation should be a dependency of scopeKeyData"
	);
});

// input <-> attribute observation
// parent: scope, child: viewModelOrAttribute
QUnit.test("child to parent mutation dependencies", function(assert) {
	var template = stache('<input value:to="age">');

	var scope = new SimpleMap({ age: 10 });
	var frag = template(scope);

	var ta = this.fixture;
	ta.appendChild(frag);

	var input = ta.getElementsByTagName("input")[0];
	var inputDependencies = mutateDeps.getKeyDependencies(input, "value");
	assert.ok(
		inputDependencies.mutatedValueDependencies.size,
		"the input should have mutation dependencies"
	);

	// tests: input <-> attribute observation
	var attributeObservation = Array.from(inputDependencies.mutatedValueDependencies)[0];
	var attributeObservationDependencies = mutateDeps.getValueDependencies(
		attributeObservation
	);
	assert.ok(
		attributeObservationDependencies.keyDependencies.get(input).has("value"),
		"the input's 'value' attribute should be a dependency of the attribute observation"
	);
});

QUnit.only("viewModel cross bindings", function(assert) {
	var vm = new SimpleMap({ value: 'vm1' });

	MockComponent.extend({
		tag: "comp-1",
		viewModel: vm
	});

	var template = stache('<comp-1 vm:value:bind="scope1"/>');

	var scope = new SimpleMap({
		scope1: 'scope1',
		scope2: 'scope2',
		scope3: 'scope3'
	});
	template(scope);

	var vmDependencies = mutateDeps.getKeyDependencies(vm, "value");
	assert.ok(vmDependencies);
});
