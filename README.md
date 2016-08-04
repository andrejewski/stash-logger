# Stash Logger

```sh
npm install stash-logger
```

```js
import StashLogger from 'stash-logger';

const myLogger = new StashLogger({
  endpoint: '/my/logs/go/here',
  appId: 'my-awesome-app'
});

myLogger.attach();
// sets the buffer write interval
// adds error listeners to window/process globals appropriately

myLogger.error('Bad stuff happened');
// ^ adds to the buffer which will group messages to send off

myLogger.errorImmediately('Really bad stuff happened');
// ^ sends this log off without waiting in the buffer

myLogger.detach();
// clears the buffer write interval
// removes error listeners from window/process
```
