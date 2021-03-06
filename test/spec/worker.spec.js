import async  from 'async';
import expect from 'expect.js';
import sinon  from 'sinon';
import Worker, { resetPortCounter } from '../../lib/worker';
import child_process from 'child_process';
import EventEmitter from 'eventemitter3';
import { config, spawn } from '../../';

const env = typeof window === 'object' ? 'browser' : 'node';

function echoThread(param, done) {
  done(param);
}

function progressThread(param, done, progress) {
  progress(0.3);
  progress(0.6);
  done();
}

function canSendAndReceive(worker, dataToSend, expectToRecv, done) {
  worker
  .once('message', (data) => {
    expect(data).to.eql(expectToRecv);
    done();
  })
  .send(dataToSend);
}

function canSendAndReceiveEcho(worker, done) {
  const testData = { foo: 'bar' };
  canSendAndReceive(worker, testData, testData, done);
}

function expectEqualBuffers(buffer1, buffer2) {
  expect(buffer2.byteLength).to.equal(buffer1.byteLength);

  for (let index = 0; index < buffer1.byteLength; index++) {
    expect(buffer2[ index ]).to.equal(buffer1[ index ]);
  }
}

describe('Worker', function () {

  this.timeout(4000);

  before(() => {
    sinon
      .stub(config, 'get')
      .returns({
        basepath : {
          node : __dirname + '/../thread-scripts',
          web  : 'http://localhost:9876/base/test/thread-scripts'
        }
      });
  });

  it('can be spawned', () => {
    const worker = spawn();

    expect(worker).to.be.a('object');
    expect(worker).to.be.a(Worker);
  });

  it('can be killed', done => {
    let spy;
    const worker = spawn();

    // the browser worker owns a worker, the node worker owns a slave
    if (env === 'browser') {
      spy = sinon.spy(worker.worker, 'terminate');
    } else {
      spy = sinon.spy(worker.slave, 'kill');
    }

    worker.on('exit', () => {
      expect(spy.calledOnce).to.be.ok();
      done();
    });
    worker.kill();
  });

  it('can run method (set using spawn())', done => {
    const worker = spawn(echoThread);
    canSendAndReceiveEcho(worker, done);
  });

  it('can run method (set using .run())', done => {
    const worker = spawn().run(echoThread);
    canSendAndReceiveEcho(worker, done);
  });

  it('can run script (set using spawn())', done => {
    const worker = spawn('abc-sender.js');
    canSendAndReceive(worker, null, 'abc', done);
  });

  it('can run script (set using .run())', done => {
    const worker = spawn(echoThread);
    canSendAndReceiveEcho(worker, done);
  });

  it('can pass more than one argument as response', done => {
    const worker = spawn((input, threadDone) => { threadDone('a', 'b', 'c'); });
    worker
      .send()
      .on('message', (a, b, c) => {
        expect(a).to.eql('a');
        expect(b).to.eql('b');
        expect(c).to.eql('c');
        worker.kill();
        done();
      });
  });

  it('can reset thread code', done => {
    const worker = spawn();

    // .run(code), .send(data), .run(script), .send(data), .run(code), .send(data)
    async.series([
      (stepDone) => {
        canSendAndReceiveEcho(worker.run(echoThread), stepDone);
      },
      (stepDone) => {
        canSendAndReceive(worker.run('abc-sender.js'), null, 'abc', stepDone);
      },
      (stepDone) => {
        canSendAndReceiveEcho(worker.run(echoThread), stepDone);
      }
    ], done);
  });

  it('can emit error', done => {
    const worker = spawn(() => {
      throw new Error('Test message');
    });

    worker.on('error', error => {
      expect(error.message).to.match(/^((Uncaught )?Error: )?Test message$/);
      done();
    });
    worker.send();
  });

  it('can promise and resolve', done => {
    const promise = spawn(echoThread)
      .send('foo bar')
      .promise();

    expect(promise).to.be.a(Promise);

    promise.then(response => {
      expect(response).to.eql('foo bar');
      done();
    });
  });

  it('can promise and reject', done => {
    const worker = spawn(() => {
      throw new Error('I fail');
    });
    const promise = worker
      .send()
      .promise();

    promise.catch(error => {
      expect(error.message).to.match(/^((Uncaught )?Error: )?I fail$/);
      done();
    });
  });

  it('can update progress', done => {
    const progressUpdates = [];
    const worker = spawn(progressThread);
    let messageHandlerInvoked = false;
    let doneHandlerInvoked = false;

    worker.on('progress', progress => {
      progressUpdates.push(progress);
    });
    worker.send();

    worker.on('message', () => {
      expect(progressUpdates).to.eql([ 0.3, 0.6 ]);
      messageHandlerInvoked = true;
      maybeDone();
    });

    worker.on('done', () => {
      expect(progressUpdates).to.eql([ 0.3, 0.6 ]);
      doneHandlerInvoked = true;
      maybeDone();
    });

    function maybeDone () {
      if (messageHandlerInvoked && doneHandlerInvoked) {
        done();
      }
    }
  });

  if (env === 'node') {

    it('can emit error on unhandled promise rejection', done => {
      const worker = spawn(() => {
        new Promise((resolve, reject) => reject(new Error('Test message')));
      });

      worker.on('error', error => {
        expect(error.message).to.match(/^((Uncaught )?Error: )?Test message$/);
        done();
      });
      worker.send();
    });

    it('thread code can use setTimeout, setInterval', done => {
      let messageCount = 0;

      const worker = spawn()
        .run((param, threadDone) => {
          setTimeout(() => {
            setInterval(() => { threadDone(true); }, 10);
          }, 20);
        })
        .send()
        .on('message', () => {
          messageCount++;
          if (messageCount === 3) {
            worker.kill();
            done();
          }
        });
    });

    // Note: these tests set a value in `process.execArgv` to test it is correctly used to generate
    // the values for the worker. If you run these tests in an IDE (for example, VS Code), it might
    // add extra values to `process.execArgv` and it will cause unexpected results in these tests.
    describe('can handle process argv', () => {
      let forkStub;
      class ForkMock extends EventEmitter {
        send(){}
      }

      beforeEach(() => {
        forkStub = sinon.stub(child_process, 'fork').returns(new ForkMock());
        resetPortCounter();
      })

      afterEach(() => {
        forkStub.restore();
      })

      it('can receive main process flags', () => {
        process.execArgv=['--arg1', '--arg2'];
        const worker = spawn();

        expect(forkStub.calledOnce).to.be.ok();
        expect(forkStub.lastCall.args[2]).to.eql({
          execArgv: ['--arg1', '--arg2']
        })
      });

      it('increments manual port for --inspect', () => {
        process.execArgv=['--inspect=1234'];
        const worker = spawn();

        expect(forkStub.lastCall.args[2]).to.eql({
          execArgv: ['--inspect=1235']
        })
      });

      it('increments manual port for --inspect-brk', () => {
        process.execArgv=['--inspect-brk=1234'];
        const worker = spawn();

        expect(forkStub.lastCall.args[2]).to.eql({
          execArgv: ['--inspect-brk=1235']
        })
      });

      it('increments default port for --inspect', () => {
        process.execArgv=['--inspect'];
        const worker = spawn();

        expect(forkStub.lastCall.args[2]).to.eql({
          execArgv: ['--inspect=9230']
        })
      });

      it('increments default port for --inspect-brk', () => {
        process.execArgv=['--inspect-brk'];
        const worker = spawn();

        expect(forkStub.lastCall.args[2]).to.eql({
          execArgv: ['--inspect-brk=9230']
        })
      });

      it('increments the port in multiple workers', () => {
        process.execArgv=['--inspect'];
        const worker1 = spawn();
        const worker2 = spawn();
        const worker3 = spawn();

        expect(forkStub.firstCall.args[2]).to.eql({ execArgv: ['--inspect=9230'] })
        expect(forkStub.secondCall.args[2]).to.eql({ execArgv: ['--inspect=9231'] })
        expect(forkStub.thirdCall.args[2]).to.eql({ execArgv: ['--inspect=9232'] })
      });

      it('can override execArgv', () => {
        process.execArgv=['--inspect'];
        const worker = spawn( echoThread, [], { execArgv: ['--my-args'] } );

        expect(forkStub.lastCall.args[2]).to.eql({ execArgv: ['--my-args'] })
      });
    })

    describe('handle option parameters', () => {
      let worker;
      let initialArgs;

      before(() => {
        initialArgs = process.execArgv;
      });

      after(() => {
        process.execArgv = initialArgs;
      });

      afterEach(() => {
        worker.kill();
      });

      it('can override options', done => {
        process.execArgv=['--arg1'];
        worker = spawn(null, [], { execArgv: ['--arg2'] });
        expect(worker.slave.spawnargs[1]).to.eql('--arg2');
        worker.kill();
        done();
      });
    });
  }


  if (env === 'browser') {

    it('can importScripts()', done => {
      const worker = spawn()
        .run(function(input, threadDone) {
          this.importedEcho(input, threadDone);
        }, [ 'import-me.js' ])
        .send('abc')
        .on('message', (response) => {
          expect(response).to.eql('abc');
          worker.kill();
          done();
        });
    });

    it('can use transferables', function(done) {
      // for some reason this test consumes extra-ordinarily much time when run on travis ci
      this.timeout(6000);

      const arrayBuffer = new Uint8Array(1024 * 2);       // 2 KB
      const arrayBufferClone = new Uint8Array(1024 * 2);
      // need to clone, because referencing arrayBuffer will not work after .send()

      for (let index = 0; index < arrayBuffer.byteLength; index++) {
        arrayBufferClone[ index ] = arrayBuffer[ index ];
      }

      const worker = spawn().
        run((input, threadDone) => {
          threadDone.transfer(input, [ input.data.buffer ]);
        })
        .send({ data: arrayBuffer }, [ arrayBuffer.buffer ])
        .on('message', (response) => {
          expectEqualBuffers(arrayBufferClone, response.data);

          worker.kill();
          done();
        });
    });

  }

  // For unknown reasons Firefox will choke on the last test cases
  // if the following test cases are not at the end:
  // (Only in Firefox, not in Chrome, not in node)

  it('can run async method (returning a Promise)', done => {
    const worker = spawn((param) => Promise.resolve(param));
    canSendAndReceiveEcho(worker, done);
  });

  it('can handle errors in an async method', done => {
    const worker = spawn(() => Promise.reject(new Error('Some error')));
    worker.on('error', error => {
      expect(error.message).to.match(/^Some error$/);
      done();
    });
    worker.send();
  });

});
