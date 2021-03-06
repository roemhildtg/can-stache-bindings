@function can-stache-bindings.toChild toChild:from
@parent can-stache-bindings.syntaxes 1

@description One-way bind a value in the parent scope to the [can-component.prototype.ViewModel ViewModel] or element.

@signature `childProp:from="key"`

  Imports [can-stache.key] in the [can-view-scope scope] to `childProp` in [can-component.prototype.view-model viewModel]. It also updates `childProp` with the value of `key` when `key` changes.

  ```
  <my-component someProp:from="value"/>
  ```

  > __Note:__ If [can-stache.key] is an object, changes to the objects properties will still be visible to the component. Objects are passed by reference. See [can-stache-bindings#OneWayBindingWithObjects One Way Binding With Objects].

  @param {String} childProp The name of the property to set in the
  component’s viewmodel.

  @param {can-stache/expressions/literal|can-stache/expressions/key-lookup|can-stache/expressions/call|can-stache/expressions/helper} key An expression whose resulting value is used to set as `childProp`.

@signature `child-prop:from="key"`

  Imports [can-stache.key] in the [can-view-scope scope] to `child-prop` property or attribute on the element.

  ```
  <input value:from="name"/>
  ```

  This signature works, but the following should be used instead:

  ```
  <input value="{{name}}"/>
  ```

@signature `vm:childProp:from="key"`

  Imports [can-stache.key] in the [can-view-scope scope] to `childProp` in [can-component.prototype.view-model viewModel]. It also updates `childProp` with the value of `key` when `key` changes.

  ```
  <my-component vm:someProp:from="value"/>
  ```

  > __Note:__ If [can-stache.key] is an object, changes to the objects properties will still be visible to the component. Objects are passed by reference. See [can-stache-bindings#OneWayBindingWithObjects One Way Binding With Objects].

Parameters are the same as [can-stache-bindings.toChild#childProp_from__key_ childProp:from="key"]

@signature `el:child-prop:from="key"`

  Imports [can-stache.key] in the [can-view-scope scope] to `child-prop` property or attribute on the element.

  ```
  <input el:value:from="name"/>
  ```

  This signature works, but the following should be used instead:

  ```
  <input value="{{name}}"/>
  ```

Parameters are the same as [can-stache-bindings.toChild#child_prop_from__key_ child-prop:from="key"]

@body

## Use

`childProp:from="key"` is used to pass values from the scope to a component.  You can use CallExpressions like:

```
<player-scores scores:from="game.scoresForPlayer('Alison')"/>
<player-scores scores:from="game.scoresForPlayer('Jeff')"/>
```

@demo demos/can-stache-bindings/to-child.html
