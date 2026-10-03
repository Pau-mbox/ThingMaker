"""Live duplex integration against the actual HTTPS tunnel. No credentials in output."""
import pathlib, json, uuid, time, base64
import websocket
root=pathlib.Path(__file__).resolve().parent.parent
key=(pathlib.Path.home()/'.thingmaker/remote-api-key.txt').read_text().strip()
url='wss://thingmaker.jacksparrot.com/v2/ws'
for token in ['', 'incorrect-key']:
    try: websocket.create_connection(url, header={'Authorization':'Bearer '+token}, timeout=20)
    except websocket.WebSocketBadStatusException as error: assert error.status_code == 401
    else: raise AssertionError('Unauthorized websocket accepted')
def connect():
    connection=websocket.create_connection(url, header={'Authorization':'Bearer '+key}, timeout=30)
    assert json.loads(connection.recv())['apiVersion']==2
    return connection
sock=connect(); events=[]; counter=0
def call(command,args=None):
    global counter
    counter+=1; identity=str(counter)
    sock.send(json.dumps({'id':identity,'command':command,'args':args or {}}))
    while True:
        frame=json.loads(sock.recv())
        if frame.get('id')==identity: return frame
        events.append(frame)
def result(command,args=None):
    frame=call(command,args)
    assert 'error' not in frame, (command,frame)
    return frame['result']
assert call('remote_key_get')['error']['code']=='UNSUPPORTED'
assert call('unknown_command')['error']['code']=='UNSUPPORTED'
workspaces=result('workspace_list')
workspace=next(w for w in workspaces if 'Remote-Demo' in w['displayPath'])
opened=result('session_open',{'request':{'workspaceId':workspace['id'],'mode':{'mode':'new'},'provider':'codex','model':'gpt-6-luna'}})
handle=opened['handle']
result('session_subscribe',{'handle':handle,'onEvent':{'__remoteChannel':'agent'}})
assert 'error' in call('session_submit',{'request':{'handle':handle,'requestId':'../unsafe','text':'no'}})
request={'handle':handle,'requestId':str(uuid.uuid4()),'text':'Reply exactly WEBSOCKET_SHARED_UI_OK and nothing else. Do not use tools or change files.'}
result('session_submit',{'request':request})
assert 'error' in call('session_submit',{'request':request})
deadline=time.monotonic()+120; text=''
while time.monotonic()<deadline:
    frame=json.loads(sock.recv()); events.append(frame)
    if frame.get('channel')=='agent':
        payload=frame['payload']['payload']
        if payload.get('kind')=='agent_message': text+=''.join(block.get('text','') for block in payload.get('content',[]))
        if 'WEBSOCKET_SHARED_UI_OK' in text: break
else: raise AssertionError('No pushed agent response')
terminal=result('terminal_open',{'request':{'workspaceId':workspace['id'],'cols':80,'rows':20}})
terminal_id=terminal['info']['id']
result('terminal_subscribe',{'id':terminal_id,'onEvent':{'__remoteChannel':'terminal'}})
# ConPTY waits for its initial cursor-position handshake; xterm does this in UI.
deadline=time.monotonic()+15
while not any(frame.get('channel')=='terminal' and frame['payload'].get('type')=='output' and b'\x1b[6n' in base64.b64decode(frame['payload']['dataBase64']) for frame in events):
    assert time.monotonic()<deadline, 'No ConPTY cursor handshake'
    events.append(json.loads(sock.recv()))
result('terminal_write',{'request':{'id':terminal_id,'text':'\x1b[1;1R'}})
result('terminal_write',{'request':{'id':terminal_id,'text':'cd\recho WS_TERMINAL_OK\r'}})
terminal_text=''.join(base64.b64decode(frame['payload']['dataBase64']).decode(errors='replace') for frame in events if frame.get('channel')=='terminal' and frame['payload'].get('type')=='output'); deadline=time.monotonic()+30
while time.monotonic()<deadline:
    if terminal_text.count('WS_TERMINAL_OK')>=2: break
    try: frame=json.loads(sock.recv())
    except websocket.WebSocketTimeoutException: break
    events.append(frame)
    if frame.get('channel')=='terminal' and frame['payload'].get('type')=='output':
        terminal_text+=base64.b64decode(frame['payload']['dataBase64']).decode(errors='replace')
        if terminal_text.count('WS_TERMINAL_OK')>=2: break
assert terminal_text.count('WS_TERMINAL_OK')>=2, repr(terminal_text)
assert 'D:\\repos\\ThingMaker-Remote-Demo' in terminal_text, 'Terminal started outside the project'
result('terminal_close',{'id':terminal_id})
snapshot=result('session_snapshot',{'handle':handle})
sock.close(); sock=connect()
replay=result('session_history',{'request':{'handle':handle,'after':'0','limit':2000}})
assert any('WEBSOCKET_SHARED_UI_OK' in json.dumps(event) for event in replay)
assert any(entry['handle']==handle for entry in result('session_list_open'))
receipt={'authRejects':True,'privateKeyCommandDenied':True,'typedCommands':True,'invalidAndDuplicateSubmitDenied':True,'pushedRealCodexReply':True,'bidirectionalTerminal':True,'reconnectReplay':True,'globalStateEvents':any(frame.get('event')=='thingmaker://remote-state-changed' for frame in events),'handle':handle,'agentSessionId':snapshot['agentSessionId']}
(root/'target/websocket-verification.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
sock.close(); print(json.dumps(receipt,indent=2))
