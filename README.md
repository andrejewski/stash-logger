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

myLogger.error('Bad stuff happened');
// ^ adds to the buffer which will group messages to send off

myLogger.errorImmediately('Really bad stuff happened');
// ^ sends this log off without waiting in the buffer
```
