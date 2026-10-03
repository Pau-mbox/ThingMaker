"""Live HTTPS verification. Reads the private local key; never prints it."""
import json, pathlib, urllib.request, urllib.error, uuid, time, secrets

key_path = pathlib.Path.home() / '.thingmaker' / 'remote-api-key.txt'
key = key_path.read_text().strip()
base = 'https://thingmaker.jacksparrot.com'
def call(operation, body=None, token=key):
    request = urllib.request.Request(base+'/v1/'+operation, data=json.dumps(body or {}).encode(), headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','User-Agent':'ThingMakerRemote/1.0'})
    with urllib.request.urlopen(request, timeout=80) as response:
        return json.load(response)
def rejects(operation, body, token, code):
    try: call(operation, body, token)
    except urllib.error.HTTPError as error: assert error.code == code, (error.code, code)
    else: raise AssertionError('Unauthorized or invalid request accepted')

rejects('workspaces', {}, '', 401)
rejects('workspaces', {}, 'incorrect-key', 401)
rejects('not-an-operation', {}, key, 404)
temporary = 'tm_'+secrets.token_hex(32)
try:
    key_path.write_text(temporary)
    rejects('workspaces', {}, key, 401)
    assert isinstance(call('workspaces', token=temporary), list)
finally: key_path.write_text(key)
workspaces = call('workspaces')
assert workspaces, 'Add a workspace in the desktop first'
workspace = next((w for w in workspaces if 'ThingMaker' in w['displayPath']), workspaces[0])
opened = call('open', {'workspaceId':workspace['id'],'mode':{'mode':'new'},'provider':'codex','model':'gpt-6-luna'})
handle = opened['handle']
rejects('submit', {'handle':handle,'requestId':'../../unsafe','text':'no'}, key, 400)
request_id=str(uuid.uuid4())
request={'handle':handle,'requestId':request_id,'text':'Reply exactly THINGMAKER_REMOTE_OK and nothing else. Do not use tools or edit files.'}
submitted=call('submit', request)
assert submitted['outcome']['outcome']=='accepted', submitted
rejects('submit', request, key, 409)
deadline=time.monotonic()+120
while time.monotonic()<deadline:
    events=call('history', {'handle':handle,'after':'0','limit':2000})
    replies=[e['payload'] for e in events if e['payload'].get('kind')=='agent_message']
    text=''.join(b.get('text','') for reply in replies for b in reply.get('content',[]))
    snapshot=call('snapshot', {'handle':handle})
    if 'THINGMAKER_REMOTE_OK' in text and snapshot['foreground'] in ['succeeded','idle']: break
    time.sleep(1)
else: raise AssertionError('Remote real-agent response did not settle')
assert any(s['handle']==handle for s in call('live'))
assert any(s['agentSessionId']==snapshot['agentSessionId'] for s in call('sessions',{'workspaceId':workspace['id']}))
call('cancel', {'handle':handle})
assert call('history', {'handle':handle,'after':'0','limit':2000})
receipt={'https':True,'authRejects':True,'keyRevocation':True,'invalidRequestIdRejects':True,'duplicateSubmitRejects':True,'realCodexReply':True,'sharedDesktopActor':True,'replay':True,'cancel':True,'workspaceId':workspace['id'],'handle':handle,'agentSessionId':snapshot['agentSessionId']}
output=pathlib.Path(__file__).resolve().parent.parent/'target'/'remote-verification.json'
output.write_text(json.dumps(receipt,indent=2))
print(json.dumps(receipt,indent=2))
