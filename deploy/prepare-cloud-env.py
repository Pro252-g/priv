#!/usr/bin/env python3
"""Create private cloud configuration without displaying or inventing credentials."""
import argparse,getpass,os,pathlib,re
p=argparse.ArgumentParser();p.add_argument('--directory',default='/etc/iep');a=p.parse_args()
folder=pathlib.Path(a.directory)
if any((folder/name).exists() for name in ('cloud.env','api.env')):p.error('Existing configuration preserved; edit it securely instead.')
domain=input('Public DNS hostname (no protocol/path): ').strip().lower()
if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?',domain) or '.' not in domain:p.error('Enter a valid public DNS hostname.')
tls_email=input('Certificate notification email: ').strip()
admin_email=input('First owner email: ').strip()
if any(not re.fullmatch(r'[^\s=]+@[^\s=]+\.[^\s=]+',v) for v in (tls_email,admin_email)):p.error('Valid emails required.')
password=getpass.getpass('First owner password (12+ characters): ')
if len(password)<12 or any(c in password for c in '\r\n\x00'):p.error('Password needs 12+ characters and must fit one environment line.')
if getpass.getpass('Repeat password: ')!=password:p.error('Passwords differ.')
folder.mkdir(parents=True,exist_ok=True,mode=0o700)
cloud=f'IEP_DOMAIN={domain}\nIEP_TLS_EMAIL={tls_email}\nIEP_API_ENV_FILE={folder}/api.env\nIEP_IMAGE_TAG=local\nIEP_NETWORK_SUBNET=172.30.55.0/24\nIEP_API_IP=172.30.55.2\nIEP_PROXY_IP=172.30.55.3\n'
for name,content in [('cloud.env',cloud),('api.env',f'IEP_ADMIN_EMAIL={admin_email}\nIEP_ADMIN_PASSWORD={password}\n')]:
 fd=os.open(folder/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:f.write(content)
print('Private configuration saved; no credential values displayed.')
